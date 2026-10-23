bind = "0.0.0.0:5001"
workers = 1
worker_class = "gthread"
threads = 8
timeout = 30
accesslog = "-"
errorlog = "-"
# Avoid logging recovery tokens, cookies, and credentials from request URLs.
access_log_format = "%(h)s %(m)s %(U)s %(s)s %(L)s"
