# usage: f NAME URL [POSTDATA]  -> writes raw/NAME.json as {meta, body}
R="$(cd "$(dirname "$0")/../raw" && pwd)"
f() {
  local name=$1 url=$2 data=$3 ts tmp code
  ts=$(date -u +%FT%T.%3NZ); tmp=$(mktemp)
  if [ -n "$data" ]; then
    code=$(curl -s -m 40 -o "$tmp" -w '%{http_code}' -H 'content-type: application/json' -H 'accept: application/json' -X POST --data "$data" "$url")
  else
    code=$(curl -s -m 40 -o "$tmp" -w '%{http_code}' -H 'accept: application/json' "$url")
  fi
  if ! jq -e . "$tmp" >/dev/null 2>&1; then jq -Rs . < "$tmp" > "$tmp.j"; mv "$tmp.j" "$tmp"; fi
  jq -n --arg u "$url" --arg t "$ts" --arg c "$code" --arg d "$data" --slurpfile bb "$tmp" \
    '{meta:{url:$u,method:(if $d=="" then "GET" else "POST" end),requestBody:(if $d=="" then null else ($d|fromjson? // $d) end),fetchedAtUtc:$t,httpStatus:($c|tonumber)},body:$bb[0]}' > "$R/$name.json"
  rm -f "$tmp"; echo "$name [$code] $(jq -c .body "$R/$name.json" | head -c 400)"
}
