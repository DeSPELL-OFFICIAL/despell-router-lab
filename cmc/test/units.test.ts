import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBaseUnits, toBaseUnits } from "../src/units.ts";

test("toBaseUnits scales whole and fractional amounts exactly", () => {
  assert.equal(toBaseUnits("100", 6), "100000000");
  assert.equal(toBaseUnits("100", 18), "100000000000000000000");
  assert.equal(toBaseUnits("0.5", 6), "500000");
  assert.equal(toBaseUnits("1.1234567", 6), "1123456");
  assert.throws(() => toBaseUnits("-1", 6));
  assert.throws(() => toBaseUnits("1e3", 6));
});

test("fromBaseUnits reads token amounts", () => {
  assert.equal(fromBaseUnits("685596148960855662", 18), 0.685596148960855662);
  assert.equal(fromBaseUnits("100000000", 6), 100);
  assert.equal(fromBaseUnits("5", 0), 5);
  assert.throws(() => fromBaseUnits("1.5", 6));
});
