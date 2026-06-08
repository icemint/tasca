# The egress allowlist proxy: a minimal pinned tinyproxy that is the agent-runner's
# ONLY route to the internet. Deny-by-default; only the hosts in ./allowlist are
# reachable, CONNECT restricted to 443. See tinyproxy.conf for the rationale.
FROM alpine:3.20

RUN apk add --no-cache tinyproxy

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist /etc/tinyproxy/allowlist

# tinyproxy drops to the User/Group from the config after binding; run it in the
# foreground so it's a well-behaved container PID 1.
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
