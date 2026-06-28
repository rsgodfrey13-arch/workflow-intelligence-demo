// importPolicy.js
const PLANS = {
  FREE: {
    MAX_TOTAL: 10000,
    MAX_PER_IMPORT: 5000,
    CHUNK_SIZE: 1000,
    MAX_INVALID_TO_RETURN: 200,
  },
  PRO: {
    MAX_TOTAL: 200000,
    MAX_PER_IMPORT: 50000,
    CHUNK_SIZE: 2000,
    MAX_INVALID_TO_RETURN: 500,
  }
};

function getPlanForUser(user) {
  // TODO: replace with your real plan logic (db column, stripe, etc.)
  return user.plan || "FREE";
}

function getPolicyForUser(user) {
  return PLANS[getPlanForUser(user)] ?? PLANS.FREE;
}

module.exports = { getPolicyForUser };
