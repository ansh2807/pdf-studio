#!/usr/bin/env python3
"""
Real document intelligence, running entirely on this server - no external AI
API key required.

The "AI Summarizer" button previously required the user to already have their
own OpenAI/Anthropic/etc API key, which defeats the actual point of a free
tool: someone who can't afford ChatGPT Plus couldn't use the summarizer
either. This module produces a genuine extractive summary and document
analysis with classical NLP - no cloud call, no key, no per-request cost -
so summarization is a real, always-available feature of the tool itself.

Algorithm (TextRank, Mihalcea & Tarau 2004 - the same family of algorithm
behind `gensim.summarize` and gnews-style summarizers, implemented here
directly so no heavy ML dependency is needed):
  1. Split the document into sentences.
  2. Represent each sentence as a TF-IDF vector over the document's own
     vocabulary (each sentence is a "document" for IDF purposes - the
     standard TextRank setup).
  3. Build a sentence-similarity graph: edge weight = cosine similarity.
  4. Run PageRank over that graph. A sentence scores highly when it is
     similar to many OTHER important sentences - i.e. it restates the
     document's central themes, which is exactly what a good extractive
     summary sentence should do.
  5. Take the top-scoring sentences, but output them in their ORIGINAL
     order so the summary still reads coherently top-to-bottom.

Also extracts, all via the same TF-IDF pass so it's nearly free:
  * Top keywords (highest aggregate TF-IDF term weight across the document).
  * Entities via regex: dates, money amounts, emails, percentages - the
    concrete facts a reader scanning a summary actually wants surfaced.
  * Basic stats: word count, sentence count, reading time, Flesch reading
    ease (a real, standard readability formula, not a made-up number).
"""
from __future__ import annotations

import math
import re
from collections import Counter

# A short, deliberately generic stopword list - this is scoring SENTENCES by
# how central their CONTENT words are, so function words need to be excluded
# or every sentence looks equally "important" via shared "the"/"and"/"is".
_STOPWORDS = frozenset("""
a about above after again against all am an and any are aren't as at be
because been before being below between both but by can't cannot could
couldn't did didn't do does doesn't doing don't down during each few for
from further had hadn't has hasn't have haven't having he he'd he'll he's
her here here's hers herself him himself his how how's i i'd i'll i'm i've
if in into is isn't it it's its itself let's me more most mustn't my myself
no nor not of off on once only or other ought our ours ourselves out over
own same shan't she she'd she'll she's should shouldn't so some such than
that that's the their theirs them themselves then there there's these they
they'd they'll they're they've this those through to too under until up
very was wasn't we we'd we'll we're we've were weren't what what's when
when's where where's which while who who's whom why why's with won't would
wouldn't you you'd you'll you're you've your yours yourself yourselves
""".split())

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'“])")
_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{1,}")

_DATE_RE = re.compile(
    r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"
    r"|\d{4}-\d{2}-\d{2}"
    r"|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}"
    r"|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})\b"
)
_MONEY_RE = re.compile(
    r"(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:thousand|million|billion|trillion|k|m|bn))?"
    r"|\d[\d,]*(?:\.\d+)?(?:\s?(?:thousand|million|billion|trillion))?\s?"
    r"(?:USD|EUR|GBP|INR|dollars?|rupees?|pounds?|euros?))",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)", re.IGNORECASE)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    raw = _SENTENCE_SPLIT.split(text)
    return [s.strip() for s in raw if len(s.strip()) >= 8]


def _tokenize(sentence: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(sentence) if w.lower() not in _STOPWORDS and len(w) > 2]


def _tfidf_vectors(sentences: list[str]) -> tuple[list[dict[str, float]], dict[str, float]]:
    tokenized = [_tokenize(s) for s in sentences]
    n = len(tokenized)
    df = Counter()
    for toks in tokenized:
        for term in set(toks):
            df[term] += 1
    idf = {term: math.log((n + 1) / (count + 1)) + 1 for term, count in df.items()}
    vectors = []
    for toks in tokenized:
        tf = Counter(toks)
        length = max(len(toks), 1)
        vectors.append({term: (count / length) * idf[term] for term, count in tf.items()})
    return vectors, idf


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    shared = set(a) & set(b)
    if not shared:
        return 0.0
    dot = sum(a[t] * b[t] for t in shared)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _pagerank(similarity: list[list[float]], damping: float = 0.85, iterations: int = 60, tol: float = 1e-6) -> list[float]:
    n = len(similarity)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    row_sums = [sum(row) or 1.0 for row in similarity]
    scores = [1.0 / n] * n
    for _ in range(iterations):
        new_scores = [(1 - damping) / n] * n
        for i in range(n):
            for j in range(n):
                if i == j or similarity[j][i] == 0:
                    continue
                new_scores[i] += damping * similarity[j][i] / row_sums[j] * scores[j]
        delta = sum(abs(new_scores[i] - scores[i]) for i in range(n))
        scores = new_scores
        if delta < tol:
            break
    return scores


def summarize(text: str, max_sentences: int = 6, max_ratio: float = 0.3) -> dict:
    """Extractive summary via TextRank. Returns sentences in ORIGINAL order,
    plus their rank so the caller can see which ones TextRank considered most
    central even after re-sorting for readability."""
    sentences = split_sentences(text)
    if not sentences:
        return {"summary": "", "sentences": [], "sentenceCount": 0}
    if len(sentences) <= max_sentences:
        return {
            "summary": " ".join(sentences),
            "sentences": [{"text": s, "rank": i} for i, s in enumerate(sentences)],
            "sentenceCount": len(sentences),
        }

    vectors, _idf = _tfidf_vectors(sentences)
    n = len(sentences)
    similarity = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            sim = _cosine(vectors[i], vectors[j])
            similarity[i][j] = sim
            similarity[j][i] = sim

    scores = _pagerank(similarity)
    target = max(1, min(max_sentences, round(n * max_ratio) or 1))
    ranked = sorted(range(n), key=lambda i: scores[i], reverse=True)[:target]
    chosen = sorted(ranked)  # back to original reading order
    return {
        "summary": " ".join(sentences[i] for i in chosen),
        "sentences": [{"text": sentences[i], "rank": rank} for rank, i in enumerate(chosen)],
        "sentenceCount": len(sentences),
    }


def top_keywords(text: str, limit: int = 12) -> list[dict]:
    """Document-wide keyword frequency - deliberately NOT the TF-IDF vectors
    used for sentence similarity above. TF-IDF's whole point is to penalize
    terms that repeat across many sentences, which is exactly backwards for
    "what is this document about": a term mentioned in 6 of 12 sentences
    ("climate change") IS the document's real theme, while a term that
    appears once in one throwaway sentence ("blue") is not, no matter how
    'distinctive' IDF considers it. Ranked by how many distinct sentences
    mention the term first (spread), then by raw count, so a term repeated
    many times within one sentence doesn't outrank a term that recurs
    throughout the document.
    """
    sentences = split_sentences(text) or [text]
    tokenized = [_tokenize(s) for s in sentences]
    term_count = Counter()
    term_spread = Counter()
    for toks in tokenized:
        term_count.update(toks)
        for term in set(toks):
            term_spread[term] += 1
    ranked = sorted(term_count.keys(), key=lambda t: (term_spread[t], term_count[t]), reverse=True)[:limit]
    return [{"term": t, "count": term_count[t], "sentences": term_spread[t]} for t in ranked]


def extract_entities(text: str) -> dict:
    return {
        "dates": sorted(set(_DATE_RE.findall(text)))[:40],
        "amounts": sorted(set(m.strip() for m in _MONEY_RE.findall(text)))[:40],
        "percentages": sorted(set(_PERCENT_RE.findall(text)))[:40],
        "emails": sorted(set(_EMAIL_RE.findall(text)))[:40],
    }


def _syllable_count(word: str) -> int:
    word = word.lower()
    vowels = "aeiouy"
    count = 0
    prev_was_vowel = False
    for ch in word:
        is_vowel = ch in vowels
        if is_vowel and not prev_was_vowel:
            count += 1
        prev_was_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(count, 1)


def readability(text: str) -> dict:
    sentences = split_sentences(text)
    words = _WORD.findall(text)
    n_sentences = max(len(sentences), 1)
    n_words = max(len(words), 1)
    n_syllables = sum(_syllable_count(w) for w in words)
    # Flesch Reading Ease: standard published formula, not a heuristic guess.
    flesch = 206.835 - 1.015 * (n_words / n_sentences) - 84.6 * (n_syllables / n_words)
    flesch = max(0.0, min(100.0, flesch))
    if flesch >= 90:
        level = "Very easy (5th grade)"
    elif flesch >= 70:
        level = "Easy (7th-8th grade)"
    elif flesch >= 60:
        level = "Standard (8th-9th grade)"
    elif flesch >= 50:
        level = "Fairly difficult (high school)"
    elif flesch >= 30:
        level = "Difficult (college)"
    else:
        level = "Very difficult (graduate)"
    return {
        "fleschScore": round(flesch, 1),
        "level": level,
        "wordCount": n_words,
        "sentenceCount": len(sentences),
        "readingTimeMinutes": round(max(n_words / 220, 0.1), 1),
    }


def analyze_document(text: str, max_sentences: int = 6) -> dict:
    """Everything the front end needs for one 'AI Summarizer' call, in one
    pass over the text: summary, keywords, entities, readability."""
    return {
        **summarize(text, max_sentences=max_sentences),
        "keywords": top_keywords(text),
        "entities": extract_entities(text),
        "readability": readability(text),
    }
