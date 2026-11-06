/*
 * libmpv 渲染模块（N-API）
 * 动态加载 libmpv-2.dll，用 MPV_RENDER_API_TYPE_SW 把视频帧渲染到内存缓冲，
 * 再由 JS 画到 canvas —— 绕开 Chromium 合成层无法显示外部进程画面的问题。
 * 音频由 mpv 直接输出到声卡，不经过浏览器。
 */
#include <node_api.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mpv/client.h"
#include "mpv/render.h"

/* ---------- 动态符号 ---------- */
typedef mpv_handle *(*fn_mpv_create)(void);
typedef int (*fn_mpv_initialize)(mpv_handle *);
typedef int (*fn_mpv_set_option_string)(mpv_handle *, const char *, const char *);
typedef int (*fn_mpv_set_property_string)(mpv_handle *, const char *, const char *);
typedef char *(*fn_mpv_get_property_string)(mpv_handle *, const char *);
typedef int (*fn_mpv_get_property)(mpv_handle *, const char *, mpv_format, void *);
typedef int (*fn_mpv_command)(mpv_handle *, const char **);
typedef int (*fn_mpv_render_context_create)(mpv_render_context **, mpv_handle *, mpv_render_param *);
typedef int (*fn_mpv_render_context_render)(mpv_render_context *, mpv_render_param *);
typedef uint64_t (*fn_mpv_render_context_update)(mpv_render_context *);
typedef void (*fn_mpv_render_context_free)(mpv_render_context *);
typedef void (*fn_mpv_terminate_destroy)(mpv_handle *);
typedef void (*fn_mpv_free)(void *);
typedef const char *(*fn_mpv_error_string)(int);
typedef unsigned long (*fn_mpv_client_api_version)(void);

static struct {
  HMODULE dll;
  fn_mpv_create create;
  fn_mpv_initialize initialize;
  fn_mpv_set_option_string set_option_string;
  fn_mpv_set_property_string set_property_string;
  fn_mpv_get_property_string get_property_string;
  fn_mpv_get_property get_property;
  fn_mpv_command command;
  fn_mpv_render_context_create rc_create;
  fn_mpv_render_context_render rc_render;
  fn_mpv_render_context_update rc_update;
  fn_mpv_render_context_free rc_free;
  fn_mpv_terminate_destroy terminate_destroy;
  fn_mpv_free mpv_free;
  fn_mpv_error_string error_string;
  fn_mpv_client_api_version api_version;
} lib;

/* ---------- 实例 ---------- */
typedef struct {
  mpv_handle *mpv;
  mpv_render_context *rc;
  unsigned char *buf;
  int w, h, stride;
  int ready;
} Instance;

static Instance *get_instance(napi_env env, napi_value v) {
  void *p = NULL;
  napi_get_value_external(env, v, &p);
  return (Instance *)p;
}

/* ---------- helpers ---------- */
static napi_value throw_err(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static int check(int rc, napi_env env, const char *what) {
  if (rc < 0 && lib.error_string) {
    char buf[512];
    snprintf(buf, sizeof(buf), "%s: %s", what, lib.error_string(rc));
    napi_throw_error(env, NULL, buf);
    return 0;
  }
  return 1;
}

/* ---------- napi_init(dllPath) ---------- */
static napi_value NapiInit(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_err(env, "需要 dll 路径");

  char path[1024];
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &len) != napi_ok)
    return throw_err(env, "路径无效");

  lib.dll = LoadLibraryA(path);
  if (!lib.dll) return throw_err(env, "加载 libmpv-2.dll 失败");

  #define RESOLVE(name, field) \
    lib.field = reinterpret_cast<decltype(lib.field)>(GetProcAddress(lib.dll, "mpv_" #name)); \
    if (!lib.field) return throw_err(env, "缺少符号 mpv_" #name);

  RESOLVE(create, create)
  RESOLVE(initialize, initialize)
  RESOLVE(set_option_string, set_option_string)
  RESOLVE(set_property_string, set_property_string)
  RESOLVE(get_property_string, get_property_string)
  RESOLVE(get_property, get_property)
  RESOLVE(command, command)
  RESOLVE(render_context_create, rc_create)
  RESOLVE(render_context_render, rc_render)
  RESOLVE(render_context_update, rc_update)
  RESOLVE(render_context_free, rc_free)
  RESOLVE(terminate_destroy, terminate_destroy)
  RESOLVE(free, mpv_free)
  RESOLVE(error_string, error_string)
  RESOLVE(client_api_version, api_version)
  #undef RESOLVE

  napi_value out;
  napi_create_object(env, &out);
  napi_value ver;
  unsigned long v = lib.api_version();
  napi_create_uint32(env, (uint32_t)v, &ver);
  napi_set_named_property(env, out, "version", ver);
  return out;
}

/* ---------- create(optionsObj) ---------- */
static void finalize_instance(napi_env env, void *data, void *hint) {
  Instance *inst = (Instance *)data;
  if (!inst) return;
  if (inst->rc && lib.rc_free) lib.rc_free(inst->rc);
  if (inst->mpv && lib.terminate_destroy) lib.terminate_destroy(inst->mpv);
  if (inst->buf) free(inst->buf);
  free(inst);
}

static napi_value NapiCreate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  Instance *inst = (Instance *)calloc(1, sizeof(Instance));
  inst->mpv = lib.create();
  if (!inst->mpv) { free(inst); return throw_err(env, "mpv_create 失败"); }

  /* 渲染走 libmpv，音频仍由 mpv 直接输出 */
  lib.set_option_string(inst->mpv, "vo", "libmpv");
  lib.set_option_string(inst->mpv, "idle", "yes");

  /* 可选配置项 */
  if (argc >= 1) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      napi_value keys;
      napi_get_property_names(env, argv[0], &keys);
      uint32_t n = 0;
      napi_get_array_length(env, keys, &n);
      for (uint32_t i = 0; i < n; i++) {
        napi_value k, v;
        napi_get_element(env, keys, i, &k);
        napi_get_property(env, argv[0], k, &v);
        char key[128] = {0}, val[1024] = {0};
        size_t l1 = 0, l2 = 0;
        napi_get_value_string_utf8(env, k, key, sizeof(key), &l1);
        napi_valuetype vt;
        napi_typeof(env, v, &vt);
        if (vt == napi_string) {
          napi_get_value_string_utf8(env, v, val, sizeof(val), &l2);
        } else if (vt == napi_number) {
          double d = 0; napi_get_value_double(env, v, &d);
          snprintf(val, sizeof(val), "%g", d);
        } else if (vt == napi_boolean) {
          bool b = false; napi_get_value_bool(env, v, &b);
          snprintf(val, sizeof(val), "%s", b ? "yes" : "no");
        } else continue;
        lib.set_option_string(inst->mpv, key, val);
      }
    }
  }

  int rc = lib.initialize(inst->mpv);
  if (rc < 0) { check(rc, env, "mpv_initialize"); return NULL; }

  napi_value ext;
  napi_create_external(env, inst, finalize_instance, NULL, &ext);
  return ext;
}

/* ---------- initRender(inst, width, height) ---------- */
static napi_value NapiInitRender(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);
  if (!inst) return throw_err(env, "无效实例");

  int32_t w = 1280, h = 720;
  napi_get_value_int32(env, argv[1], &w);
  napi_get_value_int32(env, argv[2], &h);

  if (inst->buf) { free(inst->buf); inst->buf = NULL; }
  inst->w = w; inst->h = h; inst->stride = w * 4;
  inst->buf = (unsigned char *)calloc((size_t)inst->stride * h, 1);

  mpv_render_param params[4];
  int i = 0;
  params[i].type = MPV_RENDER_PARAM_API_TYPE;
  params[i].data = (void *)MPV_RENDER_API_TYPE_SW; i++;
  params[i].type = MPV_RENDER_PARAM_INVALID;

  if (inst->rc) { lib.rc_free(inst->rc); inst->rc = NULL; }
  int rc = lib.rc_create(&inst->rc, inst->mpv, params);
  if (rc < 0) { check(rc, env, "render_context_create"); return NULL; }

  inst->ready = 1;
  napi_value out; napi_create_int32(env, 1, &out);
  return out;
}

/* ---------- update(inst) -> flags ---------- */
static napi_value NapiUpdate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);
  uint64_t flags = 0;
  if (inst && inst->rc && lib.rc_update) flags = lib.rc_update(inst->rc);
  napi_value out; napi_create_double(env, (double)flags, &out);
  return out;
}

/* ---------- render(inst) -> {buffer,width,height,stride} | null ---------- */
static napi_value NapiRender(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);
  if (!inst || !inst->rc || !inst->ready) return NULL;

  int size[2] = { inst->w, inst->h };
  size_t stride = (size_t)inst->stride;

  mpv_render_param params[6];
  int i = 0;
  params[i].type = MPV_RENDER_PARAM_SW_SIZE;   params[i].data = size;            i++;
  params[i].type = MPV_RENDER_PARAM_SW_FORMAT; params[i].data = (void *)"rgb0";   i++;
  params[i].type = MPV_RENDER_PARAM_SW_STRIDE; params[i].data = &stride;          i++;
  params[i].type = MPV_RENDER_PARAM_SW_POINTER; params[i].data = inst->buf;       i++;
  params[i].type = MPV_RENDER_PARAM_INVALID;

  uint64_t flags = lib.rc_update ? lib.rc_update(inst->rc) : 0;
  int rc = lib.rc_render(inst->rc, params);
  if (rc < 0) return NULL;

  napi_value out, buf;
  napi_create_object(env, &out);
  /* 优先外部缓冲（零拷贝）；失败则退回复制缓冲 */
  size_t total = (size_t)inst->stride * inst->h;
  napi_status st = napi_create_external_buffer(env, total, inst->buf, NULL, NULL, &buf);
  if (st != napi_ok) {
    st = napi_create_buffer_copy(env, total, inst->buf, NULL, &buf);
    if (st != napi_ok) return NULL;
  }
  napi_set_named_property(env, out, "buffer", buf);
  napi_value v;
  napi_create_int32(env, inst->w, &v); napi_set_named_property(env, out, "width", v);
  napi_create_int32(env, inst->h, &v); napi_set_named_property(env, out, "height", v);
  napi_create_int32(env, inst->stride, &v); napi_set_named_property(env, out, "stride", v);
  return out;
}

/* ---------- command(inst, [args]) ---------- */
static napi_value NapiCommand(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);
  if (!inst) return throw_err(env, "无效实例");

  uint32_t n = 0;
  napi_get_array_length(env, argv[1], &n);
  if (n == 0) return throw_err(env, "命令为空");
  if (n > 32) n = 32;

  const char *args[33];
  char *stor[32];
  memset(stor, 0, sizeof(stor));
  for (uint32_t i = 0; i < n; i++) {
    napi_value el; napi_get_element(env, argv[1], i, &el);
    size_t len = 0;
    napi_get_value_string_utf8(env, el, NULL, 0, &len);
    stor[i] = (char *)malloc(len + 1);
    napi_get_value_string_utf8(env, el, stor[i], len + 1, &len);
    args[i] = stor[i];
  }
  args[n] = NULL;

  int rc = lib.command(inst->mpv, args);
  for (uint32_t i = 0; i < n; i++) free(stor[i]);
  if (rc < 0) { check(rc, env, "command"); return NULL; }

  napi_value ok; napi_create_int32(env, 1, &ok);
  return ok;
}

/* ---------- getProp(inst, name) -> number | string | null ---------- */
static napi_value NapiGetProp(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);

  char name[128] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &len);

  double d = 0;
  if (lib.get_property(inst->mpv, name, MPV_FORMAT_DOUBLE, &d) >= 0) {
    napi_value out; napi_create_double(env, d, &out); return out;
  }
  int64_t i64 = 0;
  if (lib.get_property(inst->mpv, name, MPV_FORMAT_INT64, &i64) >= 0) {
    napi_value out; napi_create_int64(env, i64, &out); return out;
  }
  char *s = lib.get_property_string(inst->mpv, name);
  if (s) {
    napi_value out; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &out);
    lib.mpv_free(s);
    return out;
  }
  napi_value nul; napi_get_null(env, &nul);
  return nul;
}

/* ---------- setProp(inst, name, value) ---------- */
static napi_value NapiSetProp(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);

  char name[128] = {0}, val[2048] = {0};
  size_t len = 0;
  napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &len);
  napi_valuetype t;
  napi_typeof(env, argv[2], &t);
  if (t == napi_number) {
    double d = 0; napi_get_value_double(env, argv[2], &d);
    snprintf(val, sizeof(val), "%g", d);
  } else if (t == napi_boolean) {
    bool b = false; napi_get_value_bool(env, argv[2], &b);
    snprintf(val, sizeof(val), "%s", b ? "yes" : "no");
  } else {
    napi_get_value_string_utf8(env, argv[2], val, sizeof(val), &len);
  }

  int rc = lib.set_property_string(inst->mpv, name, val);
  if (rc < 0) { check(rc, env, "set_property"); return NULL; }
  napi_value ok; napi_create_int32(env, 1, &ok);
  return ok;
}

/* ---------- destroy(inst) ---------- */
static napi_value NapiDestroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Instance *inst = get_instance(env, argv[0]);
  if (!inst) { napi_value ok; napi_create_int32(env, 1, &ok); return ok; }

  inst->ready = 0;
  if (inst->rc) { lib.rc_free(inst->rc); inst->rc = NULL; }
  if (inst->mpv) { lib.terminate_destroy(inst->mpv); inst->mpv = NULL; }
  if (inst->buf) { free(inst->buf); inst->buf = NULL; }

  napi_value ok; napi_create_int32(env, 1, &ok);
  return ok;
}

/* ---------- 注册 ---------- */
#define EXPORT(name, fn) \
  { napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &f); \
    napi_set_named_property(env, exports, name, f); }

static napi_value ModuleInit(napi_env env, napi_value exports) {
  EXPORT("init", NapiInit)
  EXPORT("create", NapiCreate)
  EXPORT("initRender", NapiInitRender)
  EXPORT("render", NapiRender)
  EXPORT("update", NapiUpdate)
  EXPORT("command", NapiCommand)
  EXPORT("getProp", NapiGetProp)
  EXPORT("setProp", NapiSetProp)
  EXPORT("destroy", NapiDestroy)
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
