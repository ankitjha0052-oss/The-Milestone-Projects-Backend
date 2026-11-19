var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cors = require('cors');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var helmet = require('helmet');
require('dotenv').config();

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/user');
var applicationRouter = require('./routes/applications');
var authRouter = require('./routes/auth');
var itemsRouter = require('./routes/items');
const { jobRouter, adminRouter } = require('./routes/jobRoutes');
const adminAuthRouter = require('./routes/adminAuthRoutes');
const { paymentRouter, webhookHandler, startCronJobs } = require('./routes/paymentRoutes');

var app = express();

// Fix 4: Trust first proxy (Nginx, Render, Railway, AWS, etc.) so req.ip tracks real client IP
app.set('trust proxy', 1);

// Security Headers
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = [
  'http://localhost:5173',
  'https://themilestoneprojects.co.in',
  'http://3.108.250.29:5173',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.includes('localhost')) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));

// IMPORTANT: Webhook express.json() se PEHLE aana chahiye taaki signature check ke liye raw buffer mile
app.post("/payments/webhook", express.raw({ type: "application/json" }), webhookHandler);

// Body Parsers (Webhook ke baad)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use("/resumes", express.static(path.join(__dirname, "public/resumes")));

// Health check
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ✅ Mounted Routes
app.use('/', indexRouter);
app.use('/auth', authRouter);           // Google, Apple, Refresh, Logout
app.use('/user', usersRouter);         // Profile /user/me
app.use('/me', usersRouter);           // Direct /me support
app.use('/items', itemsRouter);        // Cursor pagination /items
app.use('/job', jobRouter);            // /job (add_job, fetch_all_jobs, etc.)
app.use('/jobs', jobRouter);           // /jobs (RESTful standard)
app.use('/admin', adminAuthRouter);   // /admin/login, /admin/stats, candidates, employers (PEHLE)
app.use('/admin', adminRouter);       // /admin/jobs (BAAD ME)
app.use('/payments', paymentRouter);   // /payments (plans, create-order, verify, subscription/me)
app.use('/applications', applicationRouter);

// Start recurring cron jobs (Hourly expiry of jobs & subscriptions)
startCronJobs();

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  if (
    req.path.startsWith('/auth') || 
    req.path.startsWith('/user') || 
    req.path.startsWith('/items') || 
    req.path.startsWith('/me') ||
    req.path.startsWith('/job') ||
    req.path.startsWith('/jobs') ||
    req.path.startsWith('/admin') ||
    req.path.startsWith('/payments')
  ) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  }
  next(createError(404));
});

// Centralized error handler
app.use(function (err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";

  if (
    req.path.startsWith('/auth') || 
    req.path.startsWith('/user') || 
    req.path.startsWith('/items') || 
    req.path.startsWith('/me') ||
    req.path.startsWith('/job') ||
    req.path.startsWith('/jobs') ||
    req.path.startsWith('/admin') ||
    req.path.startsWith('/payments') ||
    req.xhr
  ) {
    return res.status(statusCode).json({
      error: {
        code,
        message: err.message || 'An error occurred'
      }
    });
  }

  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(statusCode);
  res.render('error');
});

module.exports = app;
