using Microsoft.AspNetCore.Mvc;
using System.Threading.Tasks;

namespace MyCompany.Project.Api.Controllers
{
    /// <summary>
    /// Sample controller template following conventions: thin controllers, DTOs, and service injection.
    /// </summary>
    [ApiController]
    [Route("api/v1/[controller]")]
    public class SampleController : ControllerBase
    {
        private readonly ISampleService _service;

        public SampleController(ISampleService service)
        {
            _service = service;
        }

        /// <summary>
        /// Get sample by id.
        /// </summary>
        [HttpGet("{id}")]
        public async Task<IActionResult> GetAsync(int id)
        {
            var result = await _service.GetAsync(id).ConfigureAwait(false);
            if (result == null) return NotFound();
            return Ok(result);
        }
    }
}
