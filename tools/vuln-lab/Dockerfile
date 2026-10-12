FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts .
USER bun
ENV PORT=8090 TOKEN_FILE=/data/wvs-verification.txt
EXPOSE 8090
CMD ["bun", "server.ts"]
