import { Effect, Random } from "effect";

const slowDie: Effect.Effect<number, Error> = Effect.gen(function* () {
  yield* Effect.sleep("1 second");
  const n = yield* Random.nextIntBetween(1, 6);
  if (n > 6) yield* Effect.fail(new Error("Invalid die roll"));
  return 1;
});
