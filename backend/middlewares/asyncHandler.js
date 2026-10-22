// Wraps an async route/controller function so rejected promises reach
// Express's error handler instead of crashing the process unhandled.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
