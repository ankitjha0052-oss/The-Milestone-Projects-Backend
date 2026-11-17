require("dotenv").config();
const { sequelize } = require("./models");

async function migrate() {
  try {
    console.log("Connecting to Database...");
    await sequelize.authenticate();
    console.log("Database connected.");

    console.log("Syncing models with MySQL database...");
    await sequelize.sync({ alter: true });
    console.log("Database migration & sync completed successfully!");

    const tables = await sequelize.getQueryInterface().showAllTables();
    console.log("Tables present in DB:", tables);

    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  }
}

migrate();
