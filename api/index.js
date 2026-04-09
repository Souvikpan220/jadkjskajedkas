import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "API working" });
});

// ❌ REMOVE app.listen()

export default app;
