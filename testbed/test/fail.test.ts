import { Service, loggedMaybeFailSync } from '../src/service';

test('loggedMaybeFailSync throws on negative', () => {
  expect(() => loggedMaybeFailSync(-1)).toThrow('negative-not-allowed');
});

test('waitAndMaybeFail rejects when shouldFail', async () => {
  const svc = new Service();
  await expect(svc.waitAndMaybeFail(1, true)).rejects.toThrow('boom-async');
});
