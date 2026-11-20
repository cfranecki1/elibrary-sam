# E-Library — live deployment

Real compiled Flutter web app (`web/`) + Express API (`backend/`), served
together from one Node process: `node backend/live-server.js`
(API under `/api`, app on everything else). The backend self-seeds its
demo data on first boot.

Demo accounts: reader@elibrary.com / reader123 · admin@elibrary.com / admin123
