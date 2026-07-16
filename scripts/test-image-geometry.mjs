import assert from "node:assert/strict";
import { containImageRect, coverImageRect } from "../src/lib/imageGeometry.ts";

const contained = containImageRect(1536, 1024, 1536, 864);
assert.deepEqual(contained, { x: 120, y: 0, width: 1296, height: 864 });

const inset = containImageRect(1536, 1024, 1536, 864, 0.015);
assert.ok(inset.x > 120);
assert.ok(inset.y > 0);
assert.ok(inset.x + inset.width < 1536);
assert.ok(inset.y + inset.height < 864);

const covered = coverImageRect(1536, 1024, 1536, 864);
assert.equal(covered.x, 0);
assert.equal(covered.y, -80);
assert.equal(covered.width, 1536);
assert.equal(covered.height, 1024);

console.log("Image geometry test passed: 3:2 slide art is contained without top or bottom cropping.");
