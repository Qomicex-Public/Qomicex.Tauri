using Qomicex.Downloader.Bench;

if (args.Length == 0)
{
    Console.WriteLine("usage: verify | bench");
    return 2;
}

switch (args[0])
{
    case "verify":
        return Verify.RunAll() == 0 ? 0 : 1;
    case "bench":
        Console.WriteLine("bench not implemented yet");
        return 0;
    default:
        Console.WriteLine($"unknown command: {args[0]}");
        return 2;
}
