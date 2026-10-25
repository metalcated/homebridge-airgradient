'use strict';

const Homey = require('homey');
const { SessionManager } = require('./lib/session');

class LennoxApp extends Homey.App {
  async onInit() {
    this.sessions = new SessionManager({
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this.log('Lennox local integration started. New thermostats are read-only.');
  }

  async onUninit() {
    if (this.sessions) await this.sessions.close();
  }
}

module.exports = LennoxApp;
