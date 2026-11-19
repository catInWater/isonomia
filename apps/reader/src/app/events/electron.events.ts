import { app, dialog, ipcMain } from 'electron';
import App from '../app';
import { isTrustedSender, validateRequest } from '../api/security';

function publicBook<T extends { fileName?: string }>(book: T) {
  const { fileName: _fileName, ...safeBook } = book;
  return safeBook;
}

export default class ElectronEvents {
  static bootstrapElectronEvents(): Electron.IpcMain {
    for (const method of [
      'version',
      'storageStatus',
      'load',
      'save',
      'listRecovery',
      'recover',
      'libraryList',
      'libraryCover',
      'libraryImport',
      'libraryRemove',
      'libraryOpen',
      'openBook',
      'readChapter',
      'saveReading',
    ]) {
      ipcMain.handle(`reader:${method}`, async (event, ...args: unknown[]) => {
        if (
          !isTrustedSender(
            event.senderFrame?.url ?? '',
            event.sender === App.mainWindow?.webContents &&
              event.senderFrame === event.sender.mainFrame,
            App.documentUrl,
          )
        ) {
          throw new Error('请求来源无效。');
        }
        validateRequest(method, args);
        if (['openBook', 'readChapter', 'saveReading'].includes(method)) {
          if (!App.reading) throw new Error('本地阅读数据暂不可用。');
          if (method === 'openBook')
            return App.reading.openBook(args[0] as { bookId: string });
          if (method === 'readChapter')
            return App.reading.readChapter(
              args[0] as { bookId: string; chapterId: string },
            );
          return App.reading.saveReading(
            args[0] as import('@reader/storage-bridge').SaveReadingRequest,
          );
        }
        if (method === 'libraryOpen') {
          if (!App.reading) throw new Error('本地阅读数据暂不可用。');
          // Compatibility for Phase 1 clients, always derived from the safe adapter.
          const { book } = await App.reading.openBook({
            bookId: args[0] as string,
          });
          return { book, content: null };
        }
        if (method === 'version') return app.getVersion();
        if (method === 'libraryList')
          return ((await App.library?.list()) ?? []).map(publicBook);
        if (method === 'libraryCover')
          return App.library?.cover(args[0] as string) ?? null;
        if (method === 'libraryImport') {
          const result = await dialog.showOpenDialog(App.mainWindow!, {
            title: '导入书籍',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: '书籍', extensions: ['epub', 'txt'] }],
          });
          if (result.canceled) return [];
          const imported = [];
          for (const file of result.filePaths) {
            try {
              const book = await App.library?.importFile(file);
              if (book) imported.push(publicBook(book));
            } catch (error) {
              if ((error as { code?: string }).code === 'DUPLICATE') {
                const choice = await dialog.showMessageBox(App.mainWindow!, {
                  type: 'question',
                  title: '检测到重复书籍',
                  message:
                    error instanceof Error ? error.message : '这本书已经存在。',
                  detail: '是否仍保留为独立副本？',
                  buttons: ['跳过', '保留副本'],
                  defaultId: 0,
                  cancelId: 0,
                });
                if (choice.response === 1) {
                  try {
                    const book = await App.library?.importFile(file, true);
                    if (book) imported.push(publicBook(book));
                  } catch (retryError) {
                    imported.push({
                      error:
                        retryError instanceof Error
                          ? retryError.message
                          : '导入失败。',
                      fileName: file.split(/[\\/]/).at(-1),
                    });
                  }
                  continue;
                }
              }
              imported.push({
                error: error instanceof Error ? error.message : '导入失败。',
                fileName: file.split(/[\\/]/).at(-1),
              });
            }
          }
          return imported;
        }
        if (method === 'libraryRemove')
          return publicBook(
            await App.library!.remove(args[0] as string, args[1] as boolean),
          );
        if (method === 'storageStatus') {
          if (!App.store) {
            return {
              available: false,
              message: '无法打开本地数据目录。请检查磁盘空间和目录权限后重启。',
              recovery: [],
              expectedRevision: 0,
            };
          }
          try {
            const current = await App.store.load('settings');
            return {
              available: true,
              message: '本地数据目录已就绪。',
              recovery: [],
              expectedRevision: current?.revision ?? 0,
            };
          } catch (error) {
            const code = (error as { code?: string }).code;
            const candidates = await App.store.listRecovery('settings');
            const expectedRevision = candidates.reduce(
              (highest, candidate) =>
                candidate.name.startsWith('revision-')
                  ? Math.max(highest, candidate.revision ?? 0)
                  : highest,
              0,
            );
            if (code !== 'RECOVERY_REQUIRED') {
              return {
                available: false,
                message:
                  '无法读取本地数据。请勿删除或覆盖数据；检查磁盘权限后重启。',
                recovery: candidates,
                expectedRevision,
              };
            }
            return {
              available: false,
              message: '检测到本地数据异常。请选择经过校验的恢复点。',
              recovery: candidates,
              expectedRevision,
            };
          }
        }
        if (!App.store)
          throw new Error('本地数据暂不可用。请检查磁盘空间和目录权限后重启。');
        if (method === 'load') return await App.store.load(args[0] as string);
        if (method === 'save')
          return await App.store.save(
            args[0] as string,
            args[1] as import('../storage/index.cjs').Json,
            args[2] as number,
          );
        if (method === 'listRecovery')
          return await App.store.listRecovery(args[0] as string);
        return await App.store.recover(
          args[0] as string,
          args[1] as import('../storage/index.cjs').RecoverySelection,
        );
      });
    }
    return ipcMain;
  }
}
