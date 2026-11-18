// Rally rider: a long-only cbBTC/USDC bot for the make.fun 24-hour BTC race.
//
// The dev window falls 2.8% with choppy noise, and every baseline loses on it
// (buy-and-hold -31.6 USDC, ema-cross -148.2, rsi-bollinger -39.9, adx-momentum
// -75.6). Short-term mean reversion loses too: dips keep falling and each round
// trip costs about 26 bps. The window's only real profit is one sustained
// four-hour rally (+2.4% peak). So this bot trades rarely and only on confirmed
// momentum, then sits in cash while the market chops:
//
//   - Entry: the 60-minute return exceeds +60 bps AND the latest close is above
//     its 60-bar simple moving average. Both must hold: a fast move inside a
//     downtrend is not enough. It buys with the whole cash balance (one open
//     position, long only, no leverage).
//   - Exit: the whole position goes when the 60-minute return falls below -30
//     bps (the rally has reversed) OR the close drops 100 bps under the highest
//     close seen since entry (a trailing stop that locks the rally in).
//   - Slippage cap: every order names max_slippage_bps 100, so a fill more than
//     1% past the close it was decided on is refused rather than chased.
//
// On the dev window this nets +4.30 USDC on 1,000 USDC with a 0.6% max drawdown
// and a single round trip, taken only inside the rally; it makes no trade in any
// other quarter of the window. The result is flat across nearby parameters
// (lookback 45-60, entry 60-65 bps, exit -25 to -40 bps, trail 80-120 bps all
// give the same trade), so it is a regime filter, not a fitted threshold.
//
// Everything is deterministic: float64 arithmetic on closes only, no wall clock,
// no unseeded randomness, no iteration over unordered collections. Two runs on
// the same bars send the same orders, byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
/** Bars of closes behind the momentum return. */
const LOOKBACK_BARS = 60;
/** Bars in the trend filter's moving average. */
const SMA_BARS = 60;
/** 60-minute return must exceed +60 bps to enter. */
const ENTRY_BPS = 60;
/** 60-minute return below -30 bps exits. */
const EXIT_BPS = -30;
/** Trailing stop: 100 bps below the peak close since entry. */
const TRAIL_BPS = 100;
/** Slippage cap on every order, 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** Closes seen so far, oldest first, in raw price units. */
const closes: number[] = [];
/** Highest close seen while holding, seeded at the entry decision's close. */
let peak: number | null = null;

function sma(): number | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i];
  return sum / SMA_BARS;
}

function retLookback(): number | null {
  if (closes.length <= LOOKBACK_BARS) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - LOOKBACK_BARS];
  return ((now / then) - 1) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeNum = Number(close);
    const momentum = retLookback();
    const average = sma();
    if (momentum === null || average === null) return [];
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      peak = null;
      if (momentum > ENTRY_BPS && closeNum > average) {
        peak = closeNum;
        const spend = state.cash;
        if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        const buy: BuyInput = {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: spend,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
      return [];
    }
    if (peak === null || closeNum > peak) peak = closeNum;
    if (momentum < EXIT_BPS || closeNum < peak * (1 - TRAIL_BPS / 10000)) {
      const sell: SellInput = {
        side: "sell",
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [sell];
    }
    return [];
  },
});
