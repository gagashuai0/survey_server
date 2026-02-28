module.exports = {
  apps: [
    {
      name: 'survey-dev',
      script: 'server.js',

      // 生产环境（NODE_ENV=production）不 watch
      watch: process.env.NODE_ENV === 'development' ? ['.'] : false,
      ignore_watch: ['node_modules', 'logs'],

      // .env 优先，其次可由 pm2 --update-env 注入
      env: {
        NODE_ENV: 'development',
        PORT: process.env.PORT || '3000',
        MONGO_URI: process.env.MONGO_URI,
        MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'survey_app',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '3000',
        MONGO_URI: process.env.MONGO_URI,
        MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'survey_app',
      },
    },
  ],
};
