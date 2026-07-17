namespace Qomicex.Launcher.Backend.Neo.Diagnostics;

public sealed class TraceBufferStore
{
    private readonly object _gate = new();
    private readonly Queue<string> _entries;
    private readonly int _capacity;

    public TraceBufferStore(int capacity = 2000)
    {
        _capacity = Math.Max(1, capacity);
        _entries = new Queue<string>(_capacity);
    }

    public void Add(string entry)
    {
        lock (_gate)
        {
            if (_entries.Count == _capacity)
                _entries.Dequeue();
            _entries.Enqueue(entry);
        }
    }

    public IReadOnlyList<string> Snapshot()
    {
        lock (_gate) { return _entries.ToArray(); }
    }
}
