import { Router } from 'express';
import { bookingsRouter } from './bookings.js';
import { catalogueRouter } from './catalogue.js';
import { rulesRouter } from './rules.js';
import { schedulesRouter } from './schedules.js';
import { seriesRouter } from './series.js';

export const v1Router = Router();

// Handy while developing: shows who the token says you are.
v1Router.get('/whoami', (req, res) => {
  res.json({ tenant_id: req.tenantId, on_behalf_of: req.onBehalfOf });
});

v1Router.use(catalogueRouter); // resource types, resources
v1Router.use(rulesRouter);     // rule sets, settings
v1Router.use(schedulesRouter); // schedules, booking
v1Router.use(bookingsRouter);  // booking lifecycle
v1Router.use(seriesRouter);    // weekly timetables