# Portable image for Meadows — works on Render, Fly.io, Railway, or a
# plain VPS running Docker. Gunicorn with gthread workers and *no* request
# timeout: flask-sock's WebSocket handler (/ws/realtime) holds a connection
# open for the whole session, which a normal request timeout would kill.
# That's the deployment flask-sock's own docs recommend for gunicorn.

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home --uid 1000 meadows \
    && chown -R meadows:meadows /app
USER meadows

ENV PORT=8080
EXPOSE 8080

CMD gunicorn --bind 0.0.0.0:${PORT} --worker-class gthread --workers 2 --threads 6 --timeout 0 app:app
