// Structured Logger Service

import { storage } from './storage';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

class Logger {
  private logs: LogEntry[] = [];
  private maxLogs = 100;
  private minLevel: LogLevel = 'info';

  constructor() {
    // Set log level based on environment
    if (import.meta.env.DEV) {
      this.minLevel = 'debug';
    }
  }

  private isDebugFlagEnabled(): boolean {
    if (import.meta.env.DEV) {
      return true;
    }

    try {
      const settings = storage.getSettings();
      return settings.ui.flags.debugLogs;
    } catch {
      return false;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (level === 'debug' && !this.isDebugFlagEnabled()) {
      return false;
    }
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    };

    // Add to memory
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output with styling
    const styles: Record<LogLevel, string> = {
      debug: 'color: #888',
      info: 'color: #0ea5e9',
      warn: 'color: #f59e0b; font-weight: bold',
      error: 'color: #ef4444; font-weight: bold',
    };

    const emoji: Record<LogLevel, string> = {
      debug: '🔍',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌',
    };

    const loggerFn = level === 'debug' ? console.debug : console.log;

    loggerFn(
      `%c${emoji[level]} [${level.toUpperCase()}] ${message}`,
      styles[level],
      context ?? ''
    );

    // Store critical errors in localStorage for debugging
    if (level === 'error') {
      try {
        const errorLogs = JSON.parse(localStorage.getItem('error_logs') || '[]');
        errorLogs.push(entry);
        // Keep only last 20 errors
        if (errorLogs.length > 20) errorLogs.shift();
        localStorage.setItem('error_logs', JSON.stringify(errorLogs));
      } catch (e) {
        // Ignore storage errors
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.log('error', message, context);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
    localStorage.removeItem('error_logs');
  }

  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}

export const logger = new Logger();
