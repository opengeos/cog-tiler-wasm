import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySourceCrsResolver, setSourceCrsResolver } from '../source-crs.js';

const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k_0=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy';
const SHIFT = '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489';

test('keeps the definition without a hook', () => {
  setSourceCrsResolver(null);
  assert.equal(applySourceCrsResolver(BNG, { ProjectedCSTypeGeoKey: 27700 }), BNG);
});

test("uses the hook's definition, given the geo keys", () => {
  setSourceCrsResolver((def, keys) => (keys.ProjectedCSTypeGeoKey === 27700 ? `${def} ${SHIFT}` : undefined));
  assert.equal(applySourceCrsResolver(BNG, { ProjectedCSTypeGeoKey: 27700 }), `${BNG} ${SHIFT}`);
  // Nothing returned: the original stays.
  assert.equal(applySourceCrsResolver('+proj=longlat', { GeographicTypeGeoKey: 4326 }), '+proj=longlat');
  setSourceCrsResolver(null);
});

test('keeps the definition when the hook throws or returns a blank', () => {
  setSourceCrsResolver(() => {
    throw new Error('boom');
  });
  assert.equal(applySourceCrsResolver(BNG, {}), BNG);
  setSourceCrsResolver(() => '  ');
  assert.equal(applySourceCrsResolver(BNG, {}), BNG);
  setSourceCrsResolver(null);
});
