import { RouterBroker } from '@api/abstract/abstract.router';
import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';

export class DashboardViewRouter extends RouterBroker {
  public readonly router: Router;

  constructor() {
    super();
    this.router = Router();

    const findDashboardHtml = (): string | null => {
      const candidates = [
        path.join(process.cwd(), 'public', 'dashboard.html'),
        path.join(process.cwd(), 'dist', 'public', 'dashboard.html'),
        path.join(__dirname, '..', '..', '..', '..', '..', 'public', 'dashboard.html'),
        path.join(__dirname, '..', '..', '..', '..', 'public', 'dashboard.html'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    this.router.get('/', (req, res) => {
      const htmlPath = findDashboardHtml();
      if (htmlPath) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.sendFile(path.resolve(htmlPath));
      }
      return res.status(404).send('Dashboard view file not found in public directory');
    });

    this.router.get('*', (req, res) => {
      const htmlPath = findDashboardHtml();
      if (htmlPath) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.sendFile(path.resolve(htmlPath));
      }
      return res.status(404).send('Dashboard view file not found in public directory');
    });
  }
}
