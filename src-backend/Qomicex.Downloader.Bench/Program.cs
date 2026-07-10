using Qomicex.Downloader.Bench;
using System.Linq;

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
        return await Bench.RunAsync(args.Skip(1).ToArray());
    default:
        Console.WriteLine($"unknown command: {args[0]}");
        return 2;
}
