/**
 * JVM 站源服务（TVBox dex 虫包）的进程管理。
 *
 * 服务本身是第三方 GPLv3 组件：jvm/companion-service.jar（xiugou-tv 的 android-bridge
 * 编译产物），它自带 com.fongmi.companion.Main，启动后监听本机端口并提供 HTTP RPC：
 *   POST /spider/load   加载站点（下载 jar → 解加固 → dex2jar → 实例化 spider）
 *   POST /spider/call   homeContent / categoryContent / detailContent / searchContent / playerContent
 *   POST /spider/reset  释放全部类加载器与解壳子进程（换配置源时用）
 *
 * 这里只负责「装、起、停、超时、崩溃重启」，不复制任何 spider 调用分支。
 *
 * 关键踩坑（实测）：
 *   · 必须带 -noverify：dex2jar 产出的个别方法缺 stackmap frame，默认校验会 VerifyError，
 *     桥内会降级成 SpiderNull（表现是「站源暂不可用」）；
 *   · 必须带 -Dfile.encoding=UTF-8：否则桥内日志按 GBK 输出，中文全乱码；
 *   · 必须带 --stdin-watch=on：Node 进程被强杀时管道断开，Java 自行退出，不留孤儿进程；
 *   · 加固站首次加载要 10~20 秒（解壳 + 转换），调用方超时要给够。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = __dirname;
const JVM_DIR = path.join(ROOT, 'jvm');
const JAR = path.join(JVM_DIR, 'companion-service.jar');
const DATA_DIR = path.join(ROOT, 'data', 'jvm');
const HOME_DIR = path.join(DATA_DIR, 'home');
const LOG_FILE = path.join(DATA_DIR, 'service.log');

const MIN_JAVA = 21;
const IDLE_STOP_MS = 10 * 60 * 1000;   // 空闲 10 分钟自动停，省内存
const READY_TIMEOUT_MS = 30000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;

const st = {
  proc: null,
  port: 0,
  starting: null,
  stopping: false,
  java: '',
  startedAt: 0,
  coldStartMs: 0,
  lastError: '',
  restarts: [],       // 最近崩溃时间戳
  idleTimer: null,
  enabled: true
};

function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      try { fs.unlinkSync(LOG_FILE + '.1'); } catch (e) {}
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) {}
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) {}
}

/** 运行时是否齐全（发布包里应恒为 true；源码 clone 未跑 fetch-jvm 时为 false） */
function installed() {
  return fs.existsSync(JAR) && fs.existsSync(path.join(JVM_DIR, 'bcprov-jdk18on-1.78.1.jar'));
}

/** 按「随包 JRE → JAVA_HOME → PATH」找 java，并校验主版本 ≥ 21 */
function resolveJava() {
  if (st.java && fs.existsSync(st.java)) return st.java;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [
    path.join(ROOT, 'runtime', 'jre', 'bin', exe),
    path.join(ROOT, 'jvm', 'jre', 'bin', exe),
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', exe) : ''
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (javaMajor(c) >= MIN_JAVA) { st.java = c; return c; }
  }
  try {
    const { execFileSync } = require('child_process');
    const out = String(execFileSync(exe, ['-version'], { stdio: 'pipe', timeout: 5000, windowsHide: true }));
    if (javaMajorFromText(out) >= MIN_JAVA) { st.java = exe; return exe; }
  } catch (e) {}
  return '';
}

function javaMajor(exe) {
  try {
    const { execFileSync } = require('child_process');
    const r = require('child_process').spawnSync(exe, ['-version'], { timeout: 8000, windowsHide: true });
    return javaMajorFromText(String(r.stderr || '') + String(r.stdout || ''));
  } catch (e) { return 0; }
}

function javaMajorFromText(text) {
  const m = String(text).match(/version\s+"(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const first = Number(m[1]);
  return first === 1 ? Number(m[2] || 0) : first;
}

function touchIdle() {
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => {
    if (!st.proc) return;
    log('[idle] 空闲超时，停止 JVM 服务');
    stop();
  }, IDLE_STOP_MS);
  if (st.idleTimer.unref) st.idleTimer.unref();
}

/** 启动（单飞）：返回实际端口；失败抛错并记录 lastError */
function ensureStarted() {
  if (st.port && st.proc) { touchIdle(); return Promise.resolve(st.port); }
  if (st.starting) return st.starting;
  if (!st.enabled) return Promise.reject(new Error('JVM 站源已关闭'));
  if (!installed()) return Promise.reject(new Error('JVM 运行时缺失（先运行 tools\\fetch-jvm.ps1）'));
  const java = resolveJava();
  if (!java) return Promise.reject(new Error('未找到 Java 21+ 运行时'));
  fs.mkdirSync(HOME_DIR, { recursive: true });

  st.starting = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const args = [
      '-Duser.home=' + HOME_DIR,
      '-Dfile.encoding=UTF-8',
      '-noverify',                     // 见文件头：dex2jar 产物缺 stackmap，必须关校验
      '-jar', JAR,
      '--port=0',
      '--stdin-watch=on',
      '--parent-pid=' + process.pid
    ];
    let done = false;
    let proc;
    try {
      proc = spawn(java, args, { cwd: JVM_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      st.lastError = e.message; st.starting = null; return reject(e);
    }
    st.proc = proc;
    let outBuf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      st.lastError = '服务启动超时';
      try { proc.kill(); } catch (e) {}
      st.starting = null;
      reject(new Error(st.lastError));
    }, READY_TIMEOUT_MS);

    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      outBuf += s;
      log('[java] ' + s.trim());
      const m = outBuf.match(/\[COMPANION_READY\] PORT=(\d+)/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        st.port = Number(m[1]);
        st.startedAt = Date.now();
        st.coldStartMs = Date.now() - t0;
        st.lastError = '';
        st.starting = null;
        touchIdle();
        log(`[ready] port=${st.port} coldStart=${st.coldStartMs}ms`);
        resolve(st.port);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (chunk) => log('[java:err] ' + chunk.toString('utf8').trim()));

    proc.on('exit', (code, signal) => {
      const wasRunning = st.port > 0;
      st.proc = null;
      st.port = 0;
      if (!done) {
        done = true;
        clearTimeout(timer);
        st.starting = null;
        st.lastError = `服务启动失败（code=${code}）`;
        return reject(new Error(st.lastError));
      }
      if (wasRunning && !st.stopping) {
        log(`[crash] JVM 退出 code=${code} signal=${signal}`);
        st.lastError = `JVM 异常退出（code=${code}）`;
        const now = Date.now();
        st.restarts = st.restarts.filter(t => now - t < RESTART_WINDOW_MS);
        if (st.restarts.length < MAX_RESTARTS) {
          st.restarts.push(now);
          setTimeout(() => { if (st.enabled && !st.proc) ensureStarted().catch(() => {}); }, 1500 * st.restarts.length);
        } else {
          st.lastError = 'JVM 反复崩溃，已停止自动重启';
        }
      }
      st.stopping = false;
    });
  });
  return st.starting;
}

function stop() {
  if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
  if (!st.proc) { st.port = 0; return; }
  st.stopping = true;
  const p = st.proc;
  try { p.stdin.end(); } catch (e) {}
  try { p.kill(); } catch (e) {}
  setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 2000).unref?.();
  st.proc = null;
  st.port = 0;
}

function baseUrl() { return `http://127.0.0.1:${st.port}`; }

async function post(pathname, body, timeoutMs) {
  await ensureStarted();
  touchIdle();
  const r = await axios.post(baseUrl() + pathname, body, { timeout: timeoutMs || 75000, validateStatus: () => true });
  if (r.status !== 200) {
    const msg = (r.data && (r.data.error || r.data.detail)) || `HTTP ${r.status}`;
    const err = new Error(String(msg));
    err.status = r.status;
    err.stage = r.data && r.data.stage;
    throw err;
  }
  return r.data;
}

/** 加载站点（首次会下载 jar / 解壳 / dex2jar，慢） */
async function loadSite({ siteKey, api, ext, jar, timeoutMs }) {
  const data = await post('/spider/load', { key: siteKey, api, ext: ext || '', jar: jar || '', rpcId: `load@${siteKey}#${Date.now()}` }, timeoutMs || 180000);
  return data && data.code === 0;
}

/** 调用 spider 方法；返回 data.data（JSON 字符串或对象） */
async function callSpider({ siteKey, api, ext, jar, method, params, timeoutMs }) {
  const body = Object.assign({
    siteKey, api, ext: ext || '', jar: jar || '',
    method, rpcId: `${method}@${siteKey}#${Date.now()}`,
    timeoutMs: String(Math.max(5000, (timeoutMs || 75000) - 5000))
  }, params || {});
  const data = await post('/spider/call', body, timeoutMs || 75000);
  if (!data || data.code !== 0) {
    const err = new Error((data && (data.detail || data.error)) || '站源调用失败');
    err.stage = data && data.stage;
    throw err;
  }
  return data.data;
}

async function resetAll() {
  if (!st.port) return false;
  try { const r = await post('/spider/reset', {}, 15000); return !!(r && r.code === 0); } catch (e) { return false; }
}

function status() {
  return {
    installed: installed(),
    enabled: st.enabled,
    running: !!(st.port && st.proc),
    port: st.port || 0,
    java: st.java || '',
    coldStartMs: st.coldStartMs,
    uptimeMs: st.startedAt ? Date.now() - st.startedAt : 0,
    lastError: st.lastError
  };
}

function setEnabled(v) {
  st.enabled = !!v;
  if (!st.enabled) stop();
}

module.exports = { ensureStarted, stop, loadSite, callSpider, resetAll, status, setEnabled, installed, resolveJava, log };
