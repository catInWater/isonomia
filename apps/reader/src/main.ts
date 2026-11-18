import SquirrelEvents from './app/events/squirrel.events';
import ElectronEvents from './app/events/electron.events';
// import UpdateEvents from './app/events/update.events';
import { app, BrowserWindow } from 'electron';
import App from './app/app';

export default class Main {
  static initialize() {
    if (SquirrelEvents.handleEvents()) {
      // squirrel event handled (except first run event) and app will exit in 1000ms, so don't do anything else
      app.quit();
    }
  }

  static bootstrapApp() {
    App.main(app, BrowserWindow);
  }

  static bootstrapAppEvents() {
    ElectronEvents.bootstrapElectronEvents();

    // initialize auto updater service
    if (!App.isDevelopmentMode()) {
      // UpdateEvents.initAutoUpdateService();
    }
  }
}

// handle setup events as quickly as possible
Main.initialize();

// A single process owns the data directory and its revision queue.
if (app.requestSingleInstanceLock()) {
  Main.bootstrapApp();
  Main.bootstrapAppEvents();
  app.on('second-instance', () => {
    if (App.mainWindow?.isMinimized()) App.mainWindow.restore();
    App.mainWindow?.focus();
  });
} else {
  app.quit();
}
