using Xunit;
using Moq;
using System.Threading.Tasks;

public class SampleServiceTests
{
    [Fact]
    public async Task GetAsync_WhenExists_ReturnsValue()
    {
        var repo = new Mock<ISampleRepository>();
        repo.Setup(r => r.GetAsync(It.IsAny<int>())).ReturnsAsync(new SampleDto { Id = 1 });

        var service = new SampleService(repo.Object);

        var result = await service.GetAsync(1);

        Assert.NotNull(result);
    }
}
