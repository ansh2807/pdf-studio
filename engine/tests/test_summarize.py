#!/usr/bin/env python3
"""
Unit tests for engine/nlp/summarize.py - the local, no-API-key document
intelligence engine that replaced "AI Summarizer requires your own AI key"
(which defeated the point of a free tool for people who can't afford one).

Locks in the real bugs found while building this against a realistic
document (a paragraph mixing a genuine recurring theme with tangential
one-off sentences, real dates in multiple formats, money in symbol/word/
multiplier form, and both "%" and spelled-out "percent"):

  1. Keyword ranking used summed TF-IDF, whose whole point is to penalize
     terms that repeat across sentences - backwards for "what is this
     document about": a one-off word in a single throwaway sentence
     out-ranked the term appearing in 6 of 12 sentences. Fixed by ranking
     keywords on document-wide spread/frequency instead.
  2. The money regex didn't handle a multiplier word between the number and
     the currency word ("4 trillion dollars" was invisible).
  3. The percent regex's trailing `\\b` after `%` never matches, because `%`
     is a non-word character and `\\b` requires a word/non-word transition -
     spelled-out "50 percent" worked, "12.5%" silently didn't.

Run:  python engine/tests/test_summarize.py
"""
from __future__ import annotations
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "engine"))
from nlp import summarize as S  # noqa: E402

RESULTS = []


def chk(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}  {detail}")


DOC = (
    "Climate change is one of the most pressing challenges facing humanity today. "
    "Rising global temperatures are causing polar ice caps to melt at an unprecedented rate. "
    "Scientists warn that sea levels could rise by up to two meters by the year 2100. "
    "The company picnic was rescheduled to next Friday due to rain. "
    "Extreme weather events, including hurricanes and droughts, are becoming more frequent and severe due to climate change. "
    "Many governments have committed to reducing carbon emissions by 50 percent by 2030. "
    "Renewable energy sources such as solar and wind power are critical to addressing climate change. "
    "My favorite color is blue. "
    "The transition to clean energy requires significant investment, estimated at over 4 trillion dollars globally. "
    "Please remember to submit your timesheet by Friday, March 15th, 2026. "
    "International cooperation, such as the Paris Agreement, remains essential in the fight against climate change. "
    "Contact john.doe@example.com for more details about the sustainability report."
)


def main():
    # ---------- summarization picks the central theme, not tangents ----------
    result = S.analyze_document(DOC, max_sentences=4)
    summary = result["summary"]
    chk("summary is shorter than the source document", len(summary) < len(DOC))
    chk("summary keeps at least one core climate-change sentence", "climate change" in summary.lower())
    chk("summary drops the tangential picnic sentence", "picnic" not in summary)
    chk("summary drops the tangential favorite-color sentence", "favorite color" not in summary)
    chk("summary drops the tangential timesheet sentence", "timesheet" not in summary)

    # ---------- keyword ranking bug: recurring theme must outrank a one-off word ----------
    keywords = [k["term"] for k in result["keywords"]]
    chk("recurring theme term 'climate' ranks in the top keywords", "climate" in keywords[:5], keywords[:5])
    chk("one-off tangential term 'blue' does NOT rank above 'climate'",
        keywords.index("climate") < (keywords.index("blue") if "blue" in keywords else 999), keywords[:8])

    # ---------- entity extraction bugs ----------
    entities = result["entities"]
    chk("date in 'Month Day(st/nd/rd/th), Year' form is found", "March 15th, 2026" in entities["dates"], entities["dates"])
    chk("money with a multiplier word ('4 trillion dollars') is found",
        any("trillion" in a for a in entities["amounts"]), entities["amounts"])
    chk("email is found", "john.doe@example.com" in entities["emails"], entities["emails"])

    # ---------- percent regex: both '%' and spelled-out forms ----------
    pct_doc = "Target is 50 percent by 2030, others aim for 12.5%, a few for just 3%."
    pct = S.extract_entities(pct_doc)["percentages"]
    chk("spelled-out percent is found", "50 percent" in pct, pct)
    chk("symbol percent with a decimal is found", "12.5%" in pct, pct)
    chk("symbol percent without a decimal is found", "3%" in pct, pct)

    # ---------- money regex: symbol, word-suffix, and multiplier forms ----------
    money_doc = "Pay $12,450.00 now, wire EUR 3200 later, and budget $1.2 million for Q3."
    money = S.extract_entities(money_doc)["amounts"]
    chk("dollar-symbol amount with cents is found", any("12,450.00" in a for a in money), money)
    chk("symbol amount with a multiplier word is found", any("1.2 million" in a for a in money), money)

    # ---------- edge cases ----------
    chk("empty text returns an empty, non-crashing result", S.analyze_document("")["summary"] == "")
    short = "One sentence only."
    chk("a document shorter than the target length is returned whole, unchanged",
        S.summarize(short, max_sentences=6)["summary"] == short)

    # ---------- readability is a real, standard formula, not a fixed number ----------
    easy = "The cat sat. The dog ran. It was fun."
    hard = ("The proliferation of multifaceted epistemological frameworks necessitates "
            "an interdisciplinary reconceptualization of hermeneutical methodologies.")
    r_easy = S.readability(easy)["fleschScore"]
    r_hard = S.readability(hard)["fleschScore"]
    chk("simple short sentences score as easier to read than dense jargon",
        r_easy > r_hard, f"easy={r_easy} hard={r_hard}")

    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\nSUMMARIZE: {passed}/{total} passed")
    print("RESULT:", "PASS" if passed == total else "FAIL")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
