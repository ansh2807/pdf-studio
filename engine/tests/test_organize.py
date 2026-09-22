#!/usr/bin/env python3
"""
Organize tools test: merge / split / extract / rotate / delete / reorder.

Every page is stamped with a unique marker (MARKER-<k>) so after each operation
we can read the pages back and assert the EXACT identity and order of what
survived - not just "a PDF came out". Also exercises malformed input (bad page
specs, delete-all, non-permutation reorder) to prove the guards hold.

Run:  python engine/tests/test_organize.py
"""
from __future__ import annotations
import io, os, sys, json, subprocess, zipfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(ROOT, "engine.py")
WORK = os.path.join(HERE, "_org_work")
import fitz


def marker(k):
    return f"MARKER-{k}"


def make_doc(markers, name):
    doc = fitz.open()
    for k in markers:
        pg = doc.new_page(width=400, height=560)
        pg.insert_text((60, 80), marker(k), fontsize=24)
    p = os.path.join(WORK, name)
    doc.save(p); doc.close(); return p


def markers_of(path):
    """Return the marker integer found on each page, in page order."""
    d = fitz.open(path)
    seq = []
    for i in range(d.page_count):
        t = d[i].get_text()
        found = None
        for tok in t.split():
            if tok.startswith("MARKER-"):
                try:
                    found = int(tok.split("-")[1])
                except Exception:
                    pass
        seq.append(found)
    d.close()
    return seq


def rotations_of(path):
    d = fitz.open(path)
    r = [d[i].rotation for i in range(d.page_count)]
    d.close(); return r


def run_engine(command, **flags):
    argv = [sys.executable, ENGINE, command]
    for k, v in flags.items():
        if v is None:
            continue
        argv.append("--" + k.replace("_", "-"))
        if v is not True:
            argv.append(str(v))
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    payload = {}
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line); break
            except Exception:
                continue
    return proc.returncode, payload, proc.stderr


RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}   {detail}")


def out(name):
    return os.path.join(WORK, name)


def test_merge():
    print("\n[merge]")
    a = make_doc([1, 2], "m_a.pdf")
    b = make_doc([3, 4, 5], "m_b.pdf")
    c = make_doc([6], "m_c.pdf")
    o = out("merged.pdf")
    rc, pay, err = run_engine("merge", inputs_json=json.dumps([a, b, c]), output=o)
    check("merge/order", markers_of(o) == [1, 2, 3, 4, 5, 6], f"{markers_of(o)}")
    # guard: single input refused
    rc, pay, err = run_engine("merge", inputs_json=json.dumps([a]), output=out("x.pdf"))
    check("merge/needs-2", pay.get("ok") is False)


def test_split():
    print("\n[split]")
    src = make_doc([1, 2, 3, 4, 5], "s_src.pdf")
    # explicit ranges
    o = out("split_ranges.zip")
    rc, pay, err = run_engine("split", input=src, output=o, ranges="1-2,3-5")
    seqs = []
    with zipfile.ZipFile(o) as z:
        for nm in sorted(z.namelist()):
            tmp = out("_z.pdf"); open(tmp, "wb").write(z.read(nm))
            seqs.append(markers_of(tmp))
    check("split/ranges", seqs == [[1, 2], [3, 4, 5]], f"{seqs}")
    # every N
    o2 = out("split_every.zip")
    rc, pay, err = run_engine("split", input=src, output=o2, every=2)
    seqs = []
    with zipfile.ZipFile(o2) as z:
        for nm in sorted(z.namelist()):
            tmp = out("_z.pdf"); open(tmp, "wb").write(z.read(nm))
            seqs.append(markers_of(tmp))
    check("split/every-2", seqs == [[1, 2], [3, 4], [5]], f"{seqs}")


def test_extract():
    print("\n[extract]")
    src = make_doc([1, 2, 3, 4, 5, 6], "e_src.pdf")
    o = out("extracted.pdf")
    rc, pay, err = run_engine("extract", input=src, output=o, ranges="2,4-5")
    check("extract/subset", markers_of(o) == [2, 4, 5], f"{markers_of(o)}")
    # reversed / custom order is preserved
    o2 = out("extracted2.pdf")
    rc, pay, err = run_engine("extract", input=src, output=o2, ranges="6,1")
    check("extract/order-kept", markers_of(o2) == [6, 1], f"{markers_of(o2)}")


def test_rotate():
    print("\n[rotate]")
    src = make_doc([1, 2, 3], "r_src.pdf")
    o = out("rotated.pdf")
    rc, pay, err = run_engine("rotate", input=src, output=o, ranges="1,3", angle=90)
    rots = rotations_of(o)
    # pages 1 & 3 rotated 90, page 2 unchanged; identities intact
    check("rotate/angles", rots == [90, 0, 90], f"{rots}")
    check("rotate/identity", markers_of(o) == [1, 2, 3])


def test_delete():
    print("\n[delete]")
    src = make_doc([1, 2, 3, 4, 5], "d_src.pdf")
    o = out("deleted.pdf")
    rc, pay, err = run_engine("delete", input=src, output=o, ranges="2,4")
    check("delete/removes", markers_of(o) == [1, 3, 5], f"{markers_of(o)}")
    # guard: refuse deleting everything
    rc, pay, err = run_engine("delete", input=src, output=out("dx.pdf"), ranges="1-5")
    check("delete/refuse-all", pay.get("ok") is False)


def test_reorder():
    print("\n[reorder]")
    src = make_doc([1, 2, 3, 4], "o_src.pdf")
    o = out("reordered.pdf")
    rc, pay, err = run_engine("reorder", input=src, output=o, order="4,3,2,1")
    check("reorder/permutation", markers_of(o) == [4, 3, 2, 1], f"{markers_of(o)}")
    # guard: non-permutation refused
    rc, pay, err = run_engine("reorder", input=src, output=out("ox.pdf"), order="1,2,2")
    check("reorder/reject-bad", pay.get("ok") is False)


def test_pagespec_edges():
    print("\n[page-spec robustness]")
    sys.path.insert(0, ROOT)
    import engine as E
    cases = {
        ("all", 5): [0, 1, 2, 3, 4],
        ("1-3,5", 5): [0, 1, 2, 4],
        ("5-1", 5): [0, 1, 2, 3, 4],       # reversed range normalized
        ("3-", 5): [2, 3, 4],              # open-ended end: 3..last
        # '-2' is an open-ended START (pages 1..2), the mirror of '3-', matching
        # the common print-dialog convention. '0' and '9' are out of range and
        # 'foo' is junk - all ignored. So valid output is pages 1-2 -> [0,1].
        ("0,9,-2,foo,2", 5): [0, 1],
        ("", 3): [0, 1, 2],
    }
    ok = True
    for (spec, n), expect in cases.items():
        got = E.parse_page_spec(spec, n)
        good = got == expect
        ok = ok and good
        print(f"    parse('{spec}',{n}) -> {got} {'ok' if good else 'EXPECTED '+str(expect)}")
    check("page-spec/robust", ok)


def main():
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    test_merge(); test_split(); test_extract(); test_rotate()
    test_delete(); test_reorder(); test_pagespec_edges()
    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print("\n" + "=" * 60)
    print(f"ORGANIZE: {passed}/{total} passed")
    fails = [n for n, ok in RESULTS if not ok]
    if fails:
        print("FAILED:", ", ".join(fails))
    print("RESULT:", "PASS" if passed == total else "FAIL")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
