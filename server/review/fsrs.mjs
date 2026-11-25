// FSRS 调度（ts-fsrs 5.4.2，已 vendored）。调度器是纯函数：同样的输入 → 同样的输出。
import { fsrs, createEmptyCard, Rating, generatorParameters } from '../../vendor/ts-fsrs/dist/index.mjs';

const scheduler = fsrs(
  generatorParameters({ enable_fuzz: false, enable_short_term: false, request_retention: 0.9 }),
);

const RATING = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

export function emptyCard(now = Date.now()) {
  return createEmptyCard(new Date(now));
}

export function serialize(card) {
  return JSON.stringify(card);
}

export function deserialize(json) {
  if (!json) return null;
  const c = JSON.parse(json);
  return {
    ...c,
    due: new Date(c.due),
    last_review: c.last_review ? new Date(c.last_review) : undefined,
  };
}

/**
 * @param {object|null} state 已反序列化的 Card，没有就传 null
 * @param {'again'|'hard'|'good'|'easy'} rating
 * @param {number} now 毫秒时间戳
 * @returns {{card:object, due:number, stability:number, difficulty:number, reps:number, lapses:number}}
 */
export function schedule(state, rating, now = Date.now()) {
  const card = state ?? createEmptyCard(new Date(now));
  const record = scheduler.repeat(card, new Date(now))[RATING[rating]];
  if (!record) throw new Error(`unknown rating: ${rating}`);
  const next = record.card;
  return {
    card: next,
    due: next.due.getTime(),
    stability: next.stability,
    difficulty: next.difficulty,
    reps: next.reps,
    lapses: next.lapses,
  };
}

export const RATINGS = Object.keys(RATING);
