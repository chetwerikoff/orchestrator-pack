param()
# Emit enough stderr to fill the redirected pipe before stdout completes.
for ($i = 0; $i -lt 2000; $i++) {
    [Console]::Error.WriteLine("stderr-line-$i")
}
[Console]::Out.WriteLine('stdout-done')
