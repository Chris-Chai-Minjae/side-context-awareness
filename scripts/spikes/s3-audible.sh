#!/usr/bin/env bash
set -euo pipefail

if ! command -v aside >/dev/null 2>&1; then
  printf '{"asideAvailable":false,"probeOk":false}\n'
  exit 1
fi

code='const start=performance.now();const tabs=await listBrowserTabs();console.log(JSON.stringify({asideAvailable:true,probeOk:true,hasTabs:tabs.length>0,audibleField:tabs.some(tab=>Object.prototype.hasOwnProperty.call(tab,"audible")),anyAudible:tabs.some(tab=>tab.audible===true),queryMs:performance.now()-start}));'
if ! output=$(aside repl "$code" 2>/dev/null); then
  printf '{"asideAvailable":true,"probeOk":false}\n'
  exit 1
fi

if ! printf '%s\n' "$output" | rg -m 1 '^\{"asideAvailable":true,"probeOk":true,"hasTabs":(true|false),"audibleField":(true|false),"anyAudible":(true|false),"queryMs":[0-9.]+\}$'; then
  printf '{"asideAvailable":true,"probeOk":false}\n'
  exit 1
fi
