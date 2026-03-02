module.exports = {
  // Server
  PORT: 3000,

  // Mongo
  MONGO_URI: 'mongodb://127.0.0.1:27017/survey_app',
  MONGO_DB_NAME: 'survey_app',

  // WeChat mini-program
  appid: '',
  secret: '',

  // Admin auth
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin123456',
  ADMIN_JWT_SECRET: 'survey-admin-secret',
  ADMIN_TOKEN_EXPIRES_IN: '12h',
};

