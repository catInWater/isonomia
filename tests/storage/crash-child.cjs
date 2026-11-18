'use strict';
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const [root, mode, stage] = process.argv.slice(2);
const schemas = {
  1: (data) => typeof data?.text === 'string',
  2: (data) => typeof data?.text === 'string' && data.upgraded === true,
};
const store = new DurableStore({
  root, schemaVersion: mode === 'migrate' ? 2 : 1, schemas,
  migrations: { 1: (data) => ({ ...data, upgraded: true }) },
  checkpoint: async (current) => {
    if (current === stage) {
      process.send({ stage: current });
      await new Promise(() => {});
    }
  },
});
(async () => {
  const value = mode === 'migrate'
    ? await store.migrate('book')
    : await store.save('book', { text: 'new' }, 1);
  process.send({ acknowledged: value.revision });
  setInterval(() => {}, 1000);
})().catch((error) => { process.send({ error: error.message }); process.exitCode = 1; });
