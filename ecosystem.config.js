module.exports = {
  apps: [
    {
      name: 'survey-dev',
      script: 'server.js',

      // 生产环境（NODE_ENV=production）不 watch
      watch: process.env.NODE_ENV === 'development' ? ['.'] : false,

      ignore_watch: ['node_modules', 'logs'],

      // 根据环境注入变量
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};