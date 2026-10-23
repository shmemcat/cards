FROM python:3.11-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.11-slim
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
ARG VERSION=development
ARG REVISION=unknown
ENV CARDS_ACCOUNTS_VERSION=$VERSION CARDS_SOURCE_REVISION=$REVISION
COPY cards_accounts ./cards_accounts
COPY migrations ./migrations
COPY gunicorn_conf.py ./
RUN useradd --system --uid 10001 accounts && mkdir instance && chown accounts instance
USER accounts
EXPOSE 5001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/ready', timeout=2)"
# Provision the schema in a separate migration job before starting this image.
CMD ["gunicorn", "-c", "gunicorn_conf.py", "cards_accounts.wsgi:app"]
