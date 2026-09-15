try:
    from retry_transport import install
    install()
except Exception as exc:
    print(f'UPSTREAM_RETRY_INSTALL_FAILED {type(exc).__name__}: {exc}', flush=True)
