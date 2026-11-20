import { BrowserWindow, screen } from 'electron';
import { rendererAppName, rendererAppPort } from './constants';
import { environment } from '../environments/environment';
import { join } from 'path';
import { mkdirSync } from 'node:fs';
import { allowRequest, rendererDocument, validJson } from './api/security';
import { DurableStore } from './storage/index.cjs';
import type { Json } from './storage/index.cjs';
import { LibraryManager } from './library/index.cjs';
import { ReadingManager } from './library/reading.cjs';
import { AnnotationsManager } from './library/annotations.cjs';

export default class App {
  // Keep a global reference of the window object, if you don't, the window will
  // be closed automatically when the JavaScript object is garbage collected.
  static mainWindow: BrowserWindow | null = null;
  static application: Electron.App;
  static BrowserWindow: typeof BrowserWindow;
  static documentUrl = '';
  static storageAvailable = false;
  static store: InstanceType<typeof DurableStore> | null = null;
  static library: InstanceType<typeof LibraryManager> | null = null;
  static reading: InstanceType<typeof ReadingManager> | null = null;
  static annotations: InstanceType<typeof AnnotationsManager> | null = null;
  static libraryRoot = '';
  static storageError = '';

  public static isDevelopmentMode() {
    const isEnvironmentSet: boolean = 'ELECTRON_IS_DEV' in process.env;
    const getFromEnvironment = () =>
      parseInt(process.env.ELECTRON_IS_DEV!, 10) === 1;

    return isEnvironmentSet ? getFromEnvironment() : !environment.production;
  }

  private static onWindowAllClosed() {
    if (process.platform !== 'darwin') {
      App.application.quit();
    }
  }

  private static onReady() {
    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    if (rendererAppName) {
      App.initMainWindow();
      App.loadMainWindow();
    }
  }

  private static onActivate() {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (App.mainWindow === null) {
      App.onReady();
    }
  }

  private static initMainWindow() {
    const workAreaSize = screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(1280, workAreaSize.width || 1280);
    const height = Math.min(720, workAreaSize.height || 720);

    App.documentUrl = rendererDocument(
      __dirname,
      !App.application.isPackaged && App.isDevelopmentMode()
        ? rendererAppPort
        : undefined,
    );
    try {
      const root = join(App.application.getPath('userData'), 'data');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      App.store = new DurableStore({
        root,
        schemaVersion: 1,
        schemas: {
          1: (data: Json) =>
            validJson(data) &&
            typeof data === 'object' &&
            data !== null &&
            !Array.isArray(data),
        },
      });
      App.libraryRoot = root;
      App.library = new LibraryManager({ root, store: App.store });
      App.reading = new ReadingManager({
        root,
        store: App.store,
        library: App.library,
      });
      App.annotations = new AnnotationsManager({
        store: App.store,
        library: App.library,
        reading: App.reading,
      });
      App.storageAvailable = true;
    } catch (error) {
      App.storageAvailable = false;
      App.storageError = error instanceof Error ? error.message : 'unknown';
    }

    App.mainWindow = new BrowserWindow({
      width: width,
      height: height,
      show: false,
      webPreferences: {
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        preload: join(__dirname, 'main.preload.js'),
      },
    });
    const contents = App.mainWindow.webContents;
    contents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowRequest(details.url, App.documentUrl) });
    });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.session.on('will-download', (event) => event.preventDefault());
    App.mainWindow.setMenu(null);
    App.mainWindow.center();

    // if main window is ready to show, close the splash window and show the main window
    App.mainWindow.once('ready-to-show', () => {
      App.mainWindow!.show();
    });

    App.mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Emitted when the window is closed.
    App.mainWindow.on('closed', () => {
      // Dereference the window object, usually you would store windows
      // in an array if your app supports multi windows, this is the time
      // when you should delete the corresponding element.
      App.mainWindow = null;
    });
  }

  private static loadMainWindow() {
    void App.mainWindow!.loadURL(App.documentUrl);
  }

  static main(app: Electron.App, browserWindow: typeof BrowserWindow) {
    // we pass the Electron.App object and the
    // Electron.BrowserWindow into this function
    // so this class has no dependencies. This
    // makes the code easier to write tests for

    App.BrowserWindow = browserWindow;
    App.application = app;

    App.application.on('window-all-closed', App.onWindowAllClosed); // Quit when all windows are closed.
    App.application.on('ready', App.onReady); // App is ready to load data
    App.application.on('activate', App.onActivate); // App is activated
  }
}
