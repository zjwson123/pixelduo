#!/usr/bin/env python3
"""造一个登录态，存成 Playwright storage state，给 bench.py --storage-state 用。

工作台 /studio 在未登录时会 302 到 /login —— 不注入 cookie 的测量测的是登录页，
数字会好看得毫无意义。这个脚本注册一个一次性账号并把 session cookie 存下来。

用法：
  python3 perf/bench/mksession.py --base http://127.0.0.1:3000 --out perf/bench/session.json
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar


def post(url, data=None, headers=None, jar=None, json_body=False):
    if json_body:
        body = json.dumps(data).encode()
    elif data:
        body = urllib.parse.urlencode(data).encode()
    else:
        body = None
    req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    with opener.open(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3000")
    ap.add_argument("--out", default="perf/bench/session.json")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    # nanosecond suffix: two runs in the same second must not collide, or the
    # second register fails and every later assertion is about the same user.
    email = f"perf-{time.time_ns()}@example.com"
    password = "perfpassword123"

    # Registration is capped at 10/hour/IP (lib/rate-limit), so one session is
    # created once and reused across every measurement run of the sprint.
    if os.path.exists(args.out) and not args.force:
        print(f"{args.out} 已存在，复用（要换账号加 --force）")
        return

    jar = CookieJar()
    post(f"{base}/api/register", {"email": email, "password": password},
         {"Content-Type": "application/json"}, jar, json_body=True)
    with urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)).open(
            f"{base}/api/auth/csrf", timeout=30) as r:
        csrf = json.loads(r.read().decode())["csrfToken"]
    post(f"{base}/api/auth/callback/credentials",
         {"csrfToken": csrf, "email": email, "password": password, "json": "true"},
         {"Content-Type": "application/x-www-form-urlencoded"}, jar)

    # CookieJar rewrites a bare "localhost" host into "localhost.local", which
    # Playwright then refuses to send to http://localhost. Pin the domain to the
    # real host we are measuring.
    host = urllib.parse.urlparse(base).hostname
    cookies = [{"name": c.name, "value": c.value, "domain": host, "path": c.path,
                "expires": c.expires or -1, "httpOnly": bool(c._rest.get("HttpOnly")),
                "secure": bool(c.secure), "sameSite": "Lax"} for c in jar]
    if not any(c["name"].startswith("next-auth.session-token") for c in cookies):
        raise SystemExit(f"没拿到 session cookie，注册/登录可能失败了；cookies={[c['name'] for c in cookies]}")
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"cookies": cookies, "origins": []}, fh, indent=1)
    print(f"已写入 {args.out}（{email}）")


if __name__ == "__main__":
    main()
