/**
 * Turn a salary sentence into one number a sort can use.
 *
 * Boards publish pay as prose — "$180k - $220k", "€90,000", "$85/hr", or
 * "Competitive" — so there is no column to order by. Parsing at read time is
 * cheap for a page of results and keeps the stored posting untouched.
 */

/** Rates are quoted per hour; annualizing is the only way to rank them next to salaries. */
const HOURLY = /\bper\s+hour\b|\ban\s+hour\b|\/\s*(?:hr|hour)\b|\bhourly\b/;
const HOURS_PER_YEAR = 2080;
const AMOUNT = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;

/**
 * Below this, the number is not compensation — it is an equity percentage, a
 * level, or a headcount that wandered into the field.
 */
const MIN_PLAUSIBLE_ANNUAL = 1000;

/**
 * The headline number a posting advertises, or null when nothing parses.
 *
 * Takes the top of a published range: that is the number the posting is
 * selling, and it is the one a candidate sorting by pay is comparing.
 */
export function parseSalaryValue(
  text: string | null | undefined,
): number | null {
  if (!text) return null;
  const lowered = text.toLowerCase();

  let best: number | null = null;
  AMOUNT.lastIndex = 0;
  for (let match = AMOUNT.exec(lowered); match; match = AMOUNT.exec(lowered)) {
    const [, digits, thousands] = match;
    if (!digits) continue;
    const parsed = Number.parseFloat(digits.replace(/,/g, ""));
    if (Number.isNaN(parsed)) continue;
    const value = thousands ? parsed * 1000 : parsed;
    if (best === null || value > best) best = value;
  }

  if (best === null) return null;
  const annual =
    HOURLY.test(lowered) && best < MIN_PLAUSIBLE_ANNUAL
      ? best * HOURS_PER_YEAR
      : best;
  return annual >= MIN_PLAUSIBLE_ANNUAL ? annual : null;
}
