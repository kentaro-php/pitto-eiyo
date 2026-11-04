'use strict';
process.env.TZ = 'Asia/Tokyo';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./mock-gas.js');

test('gas/bundle/Code.gs は単体で doGet/doPost/selfCheck が動く', () => {
  const gas = createGas({ properties: { AUTH_MODE: 'dev' } });
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Code.gs'), 'utf8');
  const ctx = vm.createContext(Object.assign({}, gas.sandbox));
  vm.runInContext(bundle, ctx, { filename: 'bundle/Code.gs' });
  assert.equal(typeof ctx.doGet, 'function'); assert.equal(typeof ctx.doPost, 'function');
  const check = ctx.selfCheck();
  assert.equal(check.ok, true, JSON.stringify(check)); assert.equal(check.tables.length, 7);
  const health = JSON.parse(ctx.doGet({ parameter: { action: 'health' } }).getContent());
  assert.equal(health.ok, true); assert.equal(health.data.auth_mode, 'dev');
  const created = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action: 'product.create', token: 'dev', jan: '4901234567894', name: 'x', serving_basis: 'per_package', energy_kcal: 100 }) } }).getContent());
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(ctx.setupSheets().length, 7);
});
