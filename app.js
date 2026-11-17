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
var jobRouter = require('./routes/job');
var applicationRouter = require('./routes/applications');
var authRouter = require('./routes/auth');
var itemsRouter = require('./routes/items');

var app = express();

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use("/resumes", express.static(path.join(__dirname, "public/resumes")));

// Health check
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ✅ Routes
app.use('/', indexRouter);
app.use('/auth', authRouter);       // Google, Apple, Refresh, Logout
app.use('/user', usersRouter);     // Profile /user/me
app.use('/me', usersRouter);       // Direct /me support
app.use('/items', itemsRouter);    // Cursor pagination /items
app.use('/job', jobRouter);
app.use('/applications', applicationRouter);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  // If JSON requested or under /auth, /user, /items, return JSON 404
  if (req.path.startsWith('/auth') || req.path.startsWith('/user') || req.path.startsWith('/items') || req.path.startsWith('/me')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  }
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";

  // For API endpoints, return JSON
  if (req.path.startsWith('/auth') || req.path.startsWith('/user') || req.path.startsWith('/items') || req.path.startsWith('/me') || req.xhr) {
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
