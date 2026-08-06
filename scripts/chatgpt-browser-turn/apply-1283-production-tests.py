from subprocess import check_output

source = check_output([
    'git',
    'show',
    '678c281ec52cb8eafc38b9fa3af1e7f76d068573:scripts/chatgpt-browser-turn/apply-1283-production-tests.py',
], text=True)
start = source.index('flow_test =')
end = source.index('support =')
exec(compile(source[:start] + source[end:], 'apply-1283-production-tests.py', 'exec'))
