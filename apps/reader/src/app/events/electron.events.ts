import { app, dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import App from '../app';
import { isTrustedSender, validateRequest } from '../api/security';

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
      'libraryImport',
      'libraryRemove',
      'libraryOpen',
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
        if (method === 'version') return app.getVersion();
        if (method === 'libraryList') return await App.library?.list() ?? [];
        if (method === 'libraryImport') {
          const result = await dialog.showOpenDialog(App.mainWindow!, {
            title: '导入书籍', properties: ['openFile', 'multiSelections'],
            filters: [{ name: '书籍', extensions: ['epub', 'txt'] }],
          });
          if (result.canceled) return [];
          const imported = [];
          for (const file of result.filePaths) {
            try { imported.push(await App.library?.importFile(file)); }
            catch (error) {
              if ((error as { code?: string }).code === 'DUPLICATE') {
                const choice = await dialog.showMessageBox(App.mainWindow!, { type: 'question', title: '检测到重复书籍', message: error instanceof Error ? error.message : '这本书已经存在。', detail: '是否仍保留为独立副本？', buttons: ['跳过', '保留副本'], defaultId: 0, cancelId: 0 });
                if (choice.response === 1) { imported.push(await App.library?.importFile(file, true)); continue; }
              }
              imported.push({ error: error instanceof Error ? error.message : '导入失败。', fileName: file.split(/[\\/]/).at(-1) });
            }
          }
          return imported;
        }
        if (method === 'libraryRemove') return await App.library!.remove(args[0] as string, args[1] as boolean);
        if (method === 'libraryOpen') {
          const book = (await App.library!.list()).find((item) => item.bookId === args[0]);
          if (!book || book.fileStatus !== 'available') throw new Error('书籍文件不可用。');
          const filePath = join(App.libraryRoot, 'books', book.fileName);
          const bytes = await readFile(filePath);
          return { book, content: book.format === 'txt' ? bytes.toString('utf8') : null };
        }
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
