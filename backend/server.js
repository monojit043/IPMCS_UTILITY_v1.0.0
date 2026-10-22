require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('dev'));
app.use(cors());
app.use(express.json());

app.use('/api', apiRoutes);

// The frontend.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.use('/api', notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`IPMCS server running at http://localhost:${PORT}`);
});
