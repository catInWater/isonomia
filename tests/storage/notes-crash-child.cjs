'use strict';
const path = require('node:path');
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const {
  LibraryManager,
} = require('../../apps/reader/src/app/library/index.cjs');
const {
  ReadingManager,
} = require('../../apps/reader/src/app/library/reading.cjs');
const { NotesManager } = require('../../apps/reader/src/app/library/notes.cjs');

const [root, bookId, stage] = process.argv.slice(2);
const store = new DurableStore({
  root: path.join(root, 'data'),
  schemaVersion: 1,
  schemas: { 1: (data) => data !== null && typeof data === 'object' },
  checkpoint: async (current) => {
    if (current === stage) {
      process.send({ stage: current });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  },
});
const library = new LibraryManager({ root, store });
const reading = new ReadingManager({ root, store, library });
const notes = new NotesManager({ store, library, reading });
notes
  .save({
    bookId,
    expectedRevision: 1,
    document: JSON.stringify({
      schemaVersion: 1,
      html: '<p>unacknowledged child edit</p>',
      sources: [],
      importedAnnotationIds: [],
    }),
  })
  .then(
    (snapshot) => {
      process.send({ acknowledged: snapshot.revision });
      setInterval(() => {}, 1000);
    },
    (error) => {
      process.send({ error: error.message });
      process.exitCode = 1;
    },
  );
