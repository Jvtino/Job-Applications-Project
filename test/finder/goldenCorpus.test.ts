import { describe, expect, it } from 'vitest';
import { MATCH_LABELS, TRACKS, type MatchLabel } from '../../src/finder/shared';
import { scoreJob } from '../../src/finder/scoring/index';
import { GOLDEN_PAIRS, TRACK_SETUPS } from './fixtures/golden';

/**
 * The M8 calibration gate (plan §6/§9 R2):
 *   1. ≥90% of pairs score within ±1 band of the human label
 *   2. ZERO pairs labeled 'bad' may score ≥70 (bad-as-good false positives
 *      are the trust-killing failure — hard cap, not a percentage)
 *   3. ≥12 pairs per track, ≥120 total
 */

const bandIndex = (label: MatchLabel) => MATCH_LABELS.indexOf(label);

describe('golden corpus shape', () => {
  it('has ≥120 pairs with ≥12 per track', () => {
    expect(GOLDEN_PAIRS.length).toBeGreaterThanOrEqual(120);
    for (const track of TRACKS) {
      const count = GOLDEN_PAIRS.filter((p) => p.track === track).length;
      expect(count, track).toBeGreaterThanOrEqual(12);
    }
  });

  it('covers every label in every track', () => {
    for (const track of TRACKS) {
      const labels = new Set(GOLDEN_PAIRS.filter((p) => p.track === track).map((p) => p.expected));
      expect(labels.has('strong') || labels.has('good'), `${track} upper bands`).toBe(true);
      expect(labels.has('bad'), `${track} bad band`).toBe(true);
    }
  });
});

describe('golden corpus calibration gate', () => {
  const results = GOLDEN_PAIRS.map((pair) => {
    const { profile, prefs } = TRACK_SETUPS[pair.track];
    const scored = scoreJob(pair.job, profile, prefs);
    const drift = Math.abs(bandIndex(scored.label) - bandIndex(pair.expected));
    return { pair, scored, drift };
  });

  it('≥90% of pairs score within ±1 band of the human label', () => {
    const misses = results.filter((r) => r.drift > 1);
    const rate = (results.length - misses.length) / results.length;
    const detail = misses
      .map(
        (m) =>
          `  ${m.pair.track}/${m.pair.name}: expected ${m.pair.expected}, got ${m.scored.label} (${m.scored.overall})`,
      )
      .join('\n');
    expect(
      rate,
      `within-±1 rate ${(rate * 100).toFixed(1)}%\nmisses:\n${detail}`,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('HARD CAP: no pair labeled bad scores ≥70', () => {
    const violations = results.filter((r) => r.pair.expected === 'bad' && r.scored.overall >= 70);
    const detail = violations
      .map((v) => `  ${v.pair.track}/${v.pair.name}: scored ${v.scored.overall}`)
      .join('\n');
    expect(violations.length, `bad-as-good violations:\n${detail}`).toBe(0);
  });

  it('every scored pair carries a non-empty explanation', () => {
    for (const r of results) {
      expect(r.scored.explanation.why.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports per-track calibration (informational)', () => {
    const lines: string[] = [];
    for (const track of TRACKS) {
      const trackResults = results.filter((r) => r.pair.track === track);
      const within = trackResults.filter((r) => r.drift <= 1).length;
      const exact = trackResults.filter((r) => r.drift === 0).length;
      lines.push(`${track}: ${within}/${trackResults.length} within ±1 (${exact} exact)`);
    }
    console.log('\nGolden corpus per-track calibration:\n' + lines.join('\n'));
    expect(lines.length).toBe(TRACKS.length);
  });
});
