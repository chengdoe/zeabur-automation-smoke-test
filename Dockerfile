FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --requirement requirements.txt

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
