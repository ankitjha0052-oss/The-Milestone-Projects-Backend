
require("dotenv").config();

const app = require("./app");
const sequelize = require("./config/database");

const PORT = process.env.PORT || 8602;

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log("MySQL Database Connected Successfully");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Database Connection Failed:", error.message);
  }
}

startServer();
