#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/compare.

Locks in the real page-aligned, word-level diff engine (replaces the old
browser-only bag-of-words comparer, which just set-subtracted words with no
order/position and no idea whether one sentence changed vs the whole page).

Builds three real document pairs with KNOWN differences and drives the actual
HTTP route end-to-end:
  1. Two edited words on an otherwise-identical page -> exactly those two
     words come back in the removed/added lists, nothing else.
  2. Byte-identical documents -> "identical": true, zero pages touched.
  3. A genuinely new page appended -> classified as "inserted", not forced
     into a bogus pairing with an unrelated page.

Run:  python engine/tests/test_compare_http.py
"""
from __future__ import annotations
import os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error, json
import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
WORK = os.path.join(HERE, "proof")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


class Client:
    def __init__(self, base):
        self.base = base

    def post(self, path, files, fields=None):
        boundary = "----b" + uuid.uuid4().hex
        parts = []
        for name, (fn, data, ctype) in files.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{name}"; filename="{fn}"\r\n'
                          f'Content-Type: {ctype}\r\n\r\n').encode() + data + b"\r\n")
        for k, v in (fields or {}).items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{k}"\r\n\r\n{v}\r\n').encode())
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(self.base + path, data=body,
              headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            r = urllib.request.urlopen(req, timeout=60)
            return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), {}


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def report_from(headers):
    import base64
    b64 = headers.get("X-Engine-Report")
    if not b64:
        return {}
    return json.loads(base64.b64decode(b64))


def build_pair(path_a, path_b):
    a = fitz.open()
    p = a.new_page(width=595, height=200)
    p.insert_text((40, 80), "This agreement is between Alice and Bob.", fontsize=12)
    a.save(path_a); a.close()

    b = fitz.open()
    p = b.new_page(width=595, height=200)
    p.insert_text((40, 80), "This agreement is between Alice and Charlie.", fontsize=12)
    b.save(path_b); b.close()


def main():
    os.makedirs(WORK, exist_ok=True)
    edited_a = os.path.join(WORK, "cmp_edited_a.pdf")
    edited_b = os.path.join(WORK, "cmp_edited_b.pdf")
    build_pair(edited_a, edited_b)

    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0")
    proc = subprocess.Popen(["node", SERVER], env=env, cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"
    try:
        up = False
        for _ in range(50):
            try:
                if urllib.request.urlopen(base + "/healthz", timeout=2).status == 200:
                    up = True; break
            except Exception:
                time.sleep(0.2)
        if not up:
            print("  FAIL  server did not start"); return 1

        status = urllib.request.urlopen(base + "/api/native/status", timeout=10).read()
        feat = json.loads(status).get("features", {})
        chk("status reports compare feature", feat.get("compare") is True, feat.get("compare"))

        c = Client(base + "/api/native")

        # 1. One word changed on an otherwise-identical page.
        with open(edited_a, "rb") as fa, open(edited_b, "rb") as fb:
            st, body, headers = c.post(
                "/compare",
                {"fileA": ("a.pdf", fa.read(), "application/pdf"),
                 "fileB": ("b.pdf", fb.read(), "application/pdf")},
            )
        chk("route returns 200", st == 200, st)
        rep = report_from(headers)
        chk("exactly one word removed, one added", rep.get("wordsRemoved") == 1 and rep.get("wordsAdded") == 1, rep)
        chk("exactly one page marked modified", rep.get("pagesModified") == 1, rep)
        if st == 200:
            out = os.path.join(WORK, "cmp_http_edited.pdf")
            with open(out, "wb") as f:
                f.write(body)
            doc = fitz.open(out)
            full_text = "".join(p.get_text() for p in doc)
            doc.close()
            chk("diff PDF shows the removed word (Bob)", "Bob" in full_text, None)
            chk("diff PDF shows the added word (Charlie)", "Charlie" in full_text, None)

        # 2. Byte-identical documents.
        with open(edited_a, "rb") as fa, open(edited_a, "rb") as fa2:
            st2, body2, headers2 = c.post(
                "/compare",
                {"fileA": ("a.pdf", fa.read(), "application/pdf"),
                 "fileB": ("a2.pdf", fa2.read(), "application/pdf")},
            )
        rep2 = report_from(headers2)
        chk("identical documents report identical:true", rep2.get("identical") is True, rep2)
        chk("identical documents: zero words changed", rep2.get("wordsRemoved") == 0 and rep2.get("wordsAdded") == 0, rep2)

        # 3. A genuinely new page appended - must be "inserted", not forced
        #    into a bogus pairing.
        one_page = os.path.join(WORK, "cmp_one_page.pdf")
        two_page = os.path.join(WORK, "cmp_two_page.pdf")
        d1 = fitz.open()
        d1.new_page(width=595, height=200).insert_text((40, 80), "Shared page, unchanged.", fontsize=12)
        d1.save(one_page); d1.close()
        d2 = fitz.open()
        pg = d2.new_page(width=595, height=200)
        pg.insert_text((40, 80), "Shared page, unchanged.", fontsize=12)
        d2.new_page(width=595, height=200).insert_text((40, 80), "Brand new appended page.", fontsize=12)
        d2.save(two_page); d2.close()

        with open(one_page, "rb") as fa, open(two_page, "rb") as fb:
            st3, body3, headers3 = c.post(
                "/compare",
                {"fileA": ("one.pdf", fa.read(), "application/pdf"),
                 "fileB": ("two.pdf", fb.read(), "application/pdf")},
            )
        rep3 = report_from(headers3)
        chk("appended page classified as inserted, not modified",
            rep3.get("pagesInserted") == 1 and rep3.get("pagesModified") == 0, rep3)
        chk("shared page correctly stays unchanged", rep3.get("pagesUnchanged") == 1, rep3)

        # Missing second file must be rejected, not silently processed.
        with open(edited_a, "rb") as fa:
            st4, body4, _ = c.post("/compare", {"fileA": ("a.pdf", fa.read(), "application/pdf")})
        chk("missing second file rejected with 400", st4 == 400, st4)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP COMPARE: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
