{
  "targets": [
    {
      "target_name": "mpv_native",
      "sources": ["src/mpv_native.cpp"],
      "include_dirs": ["include"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
